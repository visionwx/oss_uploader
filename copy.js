/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');

if (!fs.existsSync(path.resolve(__dirname, './lib'))) {
    fs.mkdirSync(path.resolve(__dirname, './lib'));
}

fs.copyFileSync(path.resolve(__dirname, './src/aliyun-oss-sdk.min.js'), path.resolve(__dirname, './lib/aliyun-oss-sdk.min.js'));

console.log('copy aliyun-oss-sdk.min.js files successfully!');