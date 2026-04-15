const fs = require('fs');
const path = require('path');

function getPngSize(filePath) {
    const buffer = fs.readFileSync(filePath);
    if (buffer.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error('Not a PNG file');
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
}

try {
    const size = getPngSize('c:\\Users\\user\\Videos\\bot_final_sifras\\header_art.png');
    console.log(`${size.width}x${size.height}`);
} catch (err) {
    console.error(err.message);
}
