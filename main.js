const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let serverProcess;

function startServer() {
    // Inicia o server.js em um processo separado (fork)
    serverProcess = fork(path.join(__dirname, 'server.js'));

    serverProcess.on('error', (err) => {
        console.error('Falha ao iniciar o motor SIFRAS:', err);
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        title: "SIFRAS INVEST ATUALIZADO 0.0.1",
        backgroundColor: '#0a0b10',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.setMenuBarVisibility(false);

    // Aguarda um pouco o servidor ligar antes de carregar
    setTimeout(() => {
        win.loadURL('http://localhost:3000');
    }, 2000);
}

app.whenReady().then(() => {
    startServer();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (serverProcess) serverProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});
