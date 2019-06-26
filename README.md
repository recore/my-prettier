## MyPrettier
Prettier Standalone for VisionX and Controller

### Usage
```js
import format from '@ali/my-prettier';
import * as fs from 'fs';

// vx
const vx = fs.readFileSync('./example.vx', 'utf-8');
const formatVX = format(text, 'vx');

// controller
const ctrl = fs.readFileSync('./example.ts', 'utf-8');
const formatCtrl = format(ctrl, 'ctrl');
```
