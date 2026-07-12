const chokidar = require('chokidar');
const path = require('path');

/**
 * Watches `folderPath` for new, fully-written .zip and .txt files.
 *
 * @param {string} folderPath - absolute path to the folder to watch
 * @param {(zipPath: string) => void} onNewZip  - called for each new stable .zip file
 * @param {(txtPath: string) => void} onNewTxt  - called for each new stable .txt file
 * @returns {import('chokidar').FSWatcher}
 */
function watchFolder(folderPath, onNewZip, onNewTxt) {
  const watcher = chokidar.watch(folderPath, {
    ignored: [
      /(^|[\/\\])\../, // dotfiles
      /[\/\\]encrypted[\/\\]/, // don't re-watch our own output folder
    ],
    persistent: true,
    ignoreInitial: false, // process files already sitting in the folder on startup
    awaitWriteFinish: {
      stabilityThreshold: 3000, // wait 3s of no size change before treating file as "done"
      pollInterval: 500,
    },
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip' && typeof onNewZip === 'function') {
      onNewZip(filePath);
    } else if (ext === '.txt' && typeof onNewTxt === 'function') {
      onNewTxt(filePath);
    }
  });

  // Deduplicate EBUSY errors — OneDrive locks files during sync which causes
  // chokidar to emit many identical errors. The files are still picked up via
  // the 'add' event, so these are purely cosmetic. We log each unique path
  // only once every 10 s to keep the console clean.
  const recentEbusyPaths = new Map();
  watcher.on('error', (error) => {
    if (error.code === 'EBUSY') {
      const filePath = error.filename || error.path || '';
      const lastLogged = recentEbusyPaths.get(filePath) || 0;
      if (Date.now() - lastLogged > 10_000) {
        recentEbusyPaths.set(filePath, Date.now());
        console.warn(
          `[folderWatcher] File is locked (OneDrive syncing?), will retry: ${filePath || error.message}`
        );
      }
      return; // don't escalate — chokidar will retry automatically
    }
    console.error('[folderWatcher] Watcher error:', error.message);
  });

  return watcher;
}

module.exports = { watchFolder };
