const fs = require('fs');
const path = require('path');

const musicDir = path.join(__dirname, 'music');
const audioExt = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;

const files = fs.readdirSync(musicDir).filter(f => audioExt.test(f));

fs.writeFileSync(
  path.join(musicDir, 'songs.json'),
  JSON.stringify(files, null, 2)
);

console.log(`songs.json updated with ${files.length} track(s):`);
files.forEach(f => console.log('  - ' + f));