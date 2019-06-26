"use strict";

const format = require("../dist/my-prettier.min");
// const format = require("../src/index");
const fs = require("fs");
const path = require("path");

const urlVX = path.join(__dirname, "example.vx");

const vx = fs.readFileSync(urlVX, "utf-8");

// eslint-disable-next-line no-console
console.log(format(vx, "vx"));

const urlCtrl = path.join(__dirname, "page.ts");

const ctrl = fs.readFileSync(urlCtrl, "utf-8");

// eslint-disable-next-line no-console
console.log(">>>>>>>>>");

// eslint-disable-next-line no-console
console.log(format(ctrl, "ctrl"));
