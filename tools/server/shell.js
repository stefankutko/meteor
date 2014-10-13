var assert = require("assert");
var path = require("path");
var stream = require("stream");
var fs = require("fs");
var net = require("net");
var tty = require("tty");
var vm = require("vm");
var Fiber = require("fibers");
var eachline = require("eachline");
var chalk = require("chalk");
var EOL = require("os").EOL;
var EXITING_MESSAGE = "Shell exiting...";

// Invoked by the server process to listen for incoming connections from
// shell clients. Each connection gets its own REPL instance.
exports.listen = function listen() {
  var socketFile = getSocketFile();
  fs.unlink(socketFile, function() {
    net.createServer(function(socket) {
      startREPL(socket, socket);
    }).listen(socketFile);
  });
};

// The child process calls this function when it receives the SHELLSTART
// command from the parent process (via stdin).
function startREPL(input, output) {
  input = input || process.stdin;
  output = output || process.stdout;

  if (! output.columns) {
    // The REPL's tab completion logic assumes process.stdout is a TTY,
    // and while that isn't technically true here, we can get tab
    // completion to behave correctly if we fake the .columns property.
    output.columns = getTerminalWidth();
  }

  var repl = require("repl").start({
    prompt: "> ",
    input: input,
    output: output,
    terminal: true,
    useColors: true,
    useGlobal: true,
    ignoreUndefined: true,
    eval: evalCommand
  });

  // History persists across shell sessions!
  initializeHistory(repl);

  // Use the same `require` function and `module` object visible to the
  // shell.js module.
  repl.context.require = require;
  repl.context.module = module;
  repl.context.repl = repl;

  // Some improvements to the existing help messages.
  repl.commands[".break"].help =
    "Terminate current command input and display new prompt";
  repl.commands[".exit"].help = "Disconnect from server and leave shell";
  repl.commands[".help"].help = "Show this help information";

  // When the REPL exits, signal the attached client to exit by sending it
  // the special EXITING_MESSAGE.
  repl.on("exit", function() {
    output.write(EXITING_MESSAGE + "\n");
    output.end();
  });

  // When the server process exits, end the output stream but do not
  // signal the attached client to exit.
  process.on("exit", function() {
    output.end();
  });

  // This Meteor-specific shell command rebuilds the application as if a
  // change was made to server code.
  repl.defineCommand("reload", {
    help: "Restart the server and the shell",
    action: function() {
      process.exit(0);
    }
  });
}

function getSocketFile(appDir) {
  return path.join(appDir || getAppDir(), ".meteor", "local", "shell.sock");
}
exports.getSocketFile = getSocketFile;

// Unlinking the socket file causes all attached shell clients to
// disconnect and exit.
exports.unlinkSocketFile = function(appDir) {
  var socketFile = getSocketFile(appDir);
  try { fs.unlinkSync(socketFile); }
  catch (err) { return err; }
};

function getHistoryFile(appDir) {
  return path.join(
    appDir || getAppDir(),
    ".meteor", "local", "shell-history"
  );
}

function getAppDir() {
  for (var dir = __dirname, nextDir;
       path.basename(dir) !== ".meteor";
       dir = nextDir) {
    nextDir = path.dirname(dir);
    if (dir === nextDir) {
      throw new Error("Not a meteor project");
    }
  }
  return path.dirname(dir);
}

function getTerminalWidth() {
  try {
    // Inspired by https://github.com/TooTallNate/ttys/blob/master/index.js
    var fd = fs.openSync("/dev/tty", "r");
    assert.ok(tty.isatty(fd));
    var ws = new tty.WriteStream(fd);
    ws.end();
    return ws.columns;
  } catch (fancyApproachWasTooFancy) {
    return 80;
  }
}

// Shell commands need to be executed in fibers in case they call into
// code that yields.
function evalCommand(command, context, filename, callback) {
  Fiber(function() {
    try {
      var result = vm.runInThisContext(command, filename);
    } catch (error) {
      if (process.domain) {
        process.domain.emit("error", error);
        process.domain.exit();
      } else {
        callback(error);
      }
      return;
    }
    callback(null, result);
  }).run();
}

// This function allows a persistent history of shell commands to be saved
// to and loaded from .meteor/local/shell-history.
function initializeHistory(repl) {
  var rli = repl.rli;
  var historyFile = getHistoryFile();
  var historyFd = fs.openSync(historyFile, "a+");
  var historyLines = fs.readFileSync(historyFile, "utf8").split(EOL);
  var seenLines = Object.create(null);

  if (! rli.history) {
    rli.history = [];
    rli.historyIndex = -1;
  }

  while (rli.history && historyLines.length > 0) {
    var line = historyLines.pop();
    if (line && /\S/.test(line) && ! seenLines[line]) {
      rli.history.push(line);
      seenLines[line] = true;
    }
  }

  rli.addListener("line", function(line) {
    if (historyFd >= 0 && /\S/.test(line)) {
      fs.writeSync(historyFd, line + "\n");
    }
  });

  repl.on("exit", function() {
    fs.closeSync(historyFd);
    historyFd = -1;
  });
}

// Invoked by the process running `meteor shell` to attempt to connect to
// the server via the socket file.
exports.connect = function(appDir) {
  var socketFile = getSocketFile(appDir);
  var exitOnClose = false;
  var firstTimeConnecting = true;
  var connected = false;

  // We have to attach a "data" event even if we do nothing with the data
  // in order to put the stream in "flowing mode."
  function onData(buffer) {}

  function onConnect() {
    firstTimeConnecting = false;
    connected = true;
    overwrite(shellBanner());
    process.stdin.setRawMode(true);
  }

  function reconnect(delay) {
    if (!reconnect.timer) {
      overwrite(chalk.yellow(
        "Server unavailable (waiting to reconnect)"
      ));

      reconnect.timer = setTimeout(function() {
        delete reconnect.timer;
        connect();
      }, delay || 100);
    }
  }

  function connect() {
    if (connected) {
      return;
    }

    var sock = net.connect(socketFile);

    process.stdin.pipe(sock);
    process.stdin.on("data", onData);
    sock.pipe(process.stdout);

    sock.on("connect", onConnect);
    sock.on("close", onClose);
    sock.on("error", onError);

    eachline(sock, "utf8", function(line) {
      exitOnClose = line.indexOf(EXITING_MESSAGE) >= 0;
    });

    function onClose() {
      tearDown();

      // If we received the special EXITING_MESSAGE just before the socket
      // closed, then exit the shell instead of reconnecting.
      if (exitOnClose) {
        process.exit(0);
      } else {
        reconnect();
      }
    }

    function onError(err) {
      tearDown();

      if (err.errno === "ECONNREFUSED") {
        // If the shell.sock file exists but no server is listening on the
        // other side, keep trying to connect.
        reconnect();

      } else if (err.errno === "ENOENT") {
        // If the shell.sock file does not (yet) exist, only keep trying
        // to reconnect if this is our first time running the shell.
        if (firstTimeConnecting) {
          reconnect();
        } else {
          process.exit(0);
        }
      }
    }

    function tearDown() {
      connected = false;
      process.stdin.unpipe(sock);
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      sock.unpipe(process.stdout);
      sock.removeListener("connect", onConnect);
      sock.removeListener("close", onClose);
      sock.removeListener("error", onError);
      sock.end();
    }
  }

  connect();
};

function overwrite(textToWrite) {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  if (textToWrite) {
    process.stdout.write(textToWrite);
  }
}

function shellBanner() {
  var bannerLines = [
    "",
    "Welcome to the server-side interactive shell!"
  ];

  if (! process.env.EMACS) {
    // Tab completion sadly does not work in Emacs.
    bannerLines.push(
      "",
      "Tab compeletion is enabled for global variables."
    );
  }

  bannerLines.push(
    "",
    "Type .reload to restart the server and the shell.",
    "Type .exit to teminate the server and the shell.",
    "Type .help for additional help.",
    EOL
  );

  return chalk.green(bannerLines.join(EOL));
}
