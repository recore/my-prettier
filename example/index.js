"use strict";

const format = require("../src/index");
const fs = require("fs");
const path = require("path");

const url = path.join(__dirname, "example.vx");

const code = fs.readFileSync(url, "utf-8");

// eslint-disable-next-line no-console
console.log(format(code));
