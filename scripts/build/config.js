"use strict";

const path = require("path");
const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * @typedef {Object} Bundle
 * @property {string} input - input of the bundle
 * @property {string?} output - path of the output file in the `dist/` folder
 * @property {string?} name - name for the UMD bundle (for plugins, it'll be `prettierPlugins.${name}`)
 * @property {'node' | 'universal'} target - should generate a CJS only for node or UMD bundle
 * @property {'core' | 'plugin'} type - it's a plugin bundle or core part of prettier
 * @property {'rollup' | 'webpack'} [bundler='rollup'] - define which bundler to use
 * @property {CommonJSConfig} [commonjs={}] - options for `rollup-plugin-commonjs`
 * @property {string[]} externals - array of paths that should not be included in the final bundle
 * @property {Object.<string, string>} replace - map of strings to replace when processing the bundle
 * @property {string[]} babelPlugins - babel plugins

 * @typedef {Object} CommonJSConfig
 * @property {Object} namedExports - for cases where rollup can't infer what's exported
 * @property {string[]} ignore - paths of CJS modules to ignore
 */

/** @type {Bundle[]} */
const parsers = [].map(parser => {
  const name = getFileOutput(parser)
    .replace(/\.js$/, "")
    .split("-")[1];
  return Object.assign(parser, { type: "plugin", name });
});

/** @type {Bundle[]} */
const coreBundles = [
  {
    input: "src/index.js",
    name: "MyPrettier",
    type: "core",
    target: "universal",
    output: "my-prettier.js"
  },
  {
    input: "src/index.js",
    name: "MyPrettier",
    type: "prod",
    target: "universal",
    output: "my-prettier.min.js"
  }
];

function getFileOutput(bundle) {
  return bundle.output || path.basename(bundle.input);
}

module.exports = coreBundles
  .concat(parsers)
  .map(b => Object.assign(b, { output: getFileOutput(b) }));
