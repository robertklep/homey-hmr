const fs          = require('fs');
const { wrapper } = require('module');
const Queue       = require('debouncing-batch-queue');
const debug       = require('debug')('homey-hmr');
const watchdebug  = require('debug')('homey-hmr:watch');
const remotedebug = require('debug')('homey-hmr:remote');
const Path        = require('path');
const deglob      = require('deglob');
const url         = require('url');
const CRI         = require('chrome-remote-interface');
const chokidar    = require('chokidar');
const { docopt }  = require('docopt');

// Parse command line options.
let opts = docopt(fs.readFileSync(Path.join(__dirname, 'docopt.txt'), 'utf8'), {
  version : require('../package').version
});

module.exports = async () => {
  // Parse endpoint.
  let parsed = url.parse(opts.ENDPOINT);

  // Connect to endpoint.
  let client;
  try {
    client = await CRI({ host : parsed.hostname, port : parsed.port || 9222 });
    console.error('Connected to remote debugger.');
  } catch(e) {
    console.error(`Unable to connect to remote debugger (${ e.message })`);
    process.exit(1);
  }
  let { Runtime, Debugger } = client;

  // Load all current scripts.
  let scripts = [];
  Debugger.scriptParsed(script => scripts.push(script));
  await Debugger.enable();
  Debugger.scriptParsed(null);
  remotedebug(`Loaded ${ scripts.length } scripts.`);

  // Start watcher.
  let files   = await glob(Path.join(opts['--watch'], '**/*') );
  let watcher = chokidar.watch(files, { ignoreInitial : true });
  watchdebug(`Initially watching ${ files.length } files for changes.`);

  // Queue to handle file changes. This is used to collect and push a batch
  // of changes, instead of pushing them to the debugger separately.
  let queue = new Queue(1000);

  queue.on('data', async events => {
    debug('flushing queue');
    let mods = events.reduce((acc, file) => {
      acc[file.ev].push(file.path);
      return acc;
    }, { add : [], change : [], unlink : [] });

    debug(`pushing changes (#add: ${ mods.add.length}, #change : ${ mods.change.length }, #unlink : ${ mods.unlink.length })`);

    // Apply file changes.
    await Promise.all(mods.change.map(path => {
      let rpath = relpath(path);

      // Find script id for path.
      let script = scripts.find(s => s.url === rpath);
      if (! script) {
        return console.error('unable to find scriptId for', rpath);
      }

      remotedebug(`changing source for '${ rpath }' (id: ${ script.scriptId })`);
      return Debugger.setScriptSource({
        scriptId     : script.scriptId,
        // Needs to be wrapper by the default Node.js module wrapper.
        scriptSource : wrapper[0] + fs.readFileSync(path, 'utf-8') + wrapper[1],
      });
    }));

  });

  // Watch for changes. Push each into the queue which will collect and batch them.
  watcher.on('add', path => {
    queue.add({ ev : 'add',    path : path });
  }).on('change', path => {
    queue.add({ ev : 'change', path : path });
  }).on('unlink', path => {
    queue.add({ ev : 'unlink', path : path });
  });
}

// Modify local filename to a path that the remote debugger expects.
function relpath(path) {
  return '/' + Path.relative(opts['--watch'], path);
}

// Promisified `deglob`
function glob(pattern) {
  return new Promise((resolve, reject) => {
    deglob([ pattern ], (err, files) => {
      if (err) return reject(err);
      return resolve(files);
    });
  });
}
