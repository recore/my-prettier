## vx-format
Prettier Standalone for VisionX

### Usage
```sh
import format from '@ali/vx-format';
import * as fs from 'fs';

const text = fs.readFileSync('./example.vx', 'utf-8');
const code = format(text);
```
