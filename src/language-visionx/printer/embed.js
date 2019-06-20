"use strict";

const { isBlockComment, hasLeadingComment } = require("./comments");

const {
  builders: { indent, hardline, softline, concat, group },
  utils: { mapDoc, stripTrailingHardline }
} = require("../../doc");

function embed(path, print, textToDoc /*, options */) {
  const node = path.getValue();

  switch (node.type) {
    case "TemplateLiteral": {
      const isCss = [isStyledJsx, isStyledComponents, isCssProp].some(isIt =>
        isIt(path)
      );

      if (isCss) {
        // Get full template literal with expressions replaced by placeholders
        const rawQuasis = node.quasis.map(q => q.value.raw);
        let placeholderID = 0;
        const text = rawQuasis.reduce((prevVal, currVal, idx) => {
          return idx == 0
            ? currVal
            : prevVal +
                "@prettier-placeholder-" +
                placeholderID++ +
                "-id" +
                currVal;
        }, "");
        const doc = textToDoc(text, { parser: "css" });
        return transformCssDoc(doc, path, print);
      }

      if (isHtml(path)) {
        return printHtmlTemplateLiteral(path, print, textToDoc, "html");
      }

      break;
    }
    default:
      break;
  }
}

function transformCssDoc(quasisDoc, path, print) {
  const parentNode = path.getValue();

  const isEmpty =
    parentNode.quasis.length === 1 && !parentNode.quasis[0].value.raw.trim();
  if (isEmpty) {
    return "``";
  }

  const expressionDocs = parentNode.expressions
    ? path.map(print, "expressions")
    : [];
  const newDoc = replacePlaceholders(quasisDoc, expressionDocs);
  /* istanbul ignore if */
  if (!newDoc) {
    throw new Error("Couldn't insert all the expressions");
  }
  return concat([
    "`",
    indent(concat([hardline, stripTrailingHardline(newDoc)])),
    softline,
    "`"
  ]);
}

// Search all the placeholders in the quasisDoc tree
// and replace them with the expression docs one by one
// returns a new doc with all the placeholders replaced,
// or null if it couldn't replace any expression
function replacePlaceholders(quasisDoc, expressionDocs) {
  if (!expressionDocs || !expressionDocs.length) {
    return quasisDoc;
  }

  const expressions = expressionDocs.slice();
  let replaceCounter = 0;
  const newDoc = mapDoc(quasisDoc, doc => {
    if (!doc || !doc.parts || !doc.parts.length) {
      return doc;
    }
    let parts = doc.parts;
    const atIndex = parts.indexOf("@");
    const placeholderIndex = atIndex + 1;
    if (
      atIndex > -1 &&
      typeof parts[placeholderIndex] === "string" &&
      parts[placeholderIndex].startsWith("prettier-placeholder")
    ) {
      // If placeholder is split, join it
      const at = parts[atIndex];
      const placeholder = parts[placeholderIndex];
      const rest = parts.slice(placeholderIndex + 1);
      parts = parts
        .slice(0, atIndex)
        .concat([at + placeholder])
        .concat(rest);
    }
    const atPlaceholderIndex = parts.findIndex(
      part =>
        typeof part === "string" && part.startsWith("@prettier-placeholder")
    );
    if (atPlaceholderIndex > -1) {
      const placeholder = parts[atPlaceholderIndex];
      const rest = parts.slice(atPlaceholderIndex + 1);
      const placeholderMatch = placeholder.match(
        /@prettier-placeholder-(.+)-id([\s\S]*)/
      );
      const placeholderID = placeholderMatch[1];
      // When the expression has a suffix appended, like:
      // animation: linear ${time}s ease-out;
      const suffix = placeholderMatch[2];
      const expression = expressions[placeholderID];

      replaceCounter++;
      parts = parts
        .slice(0, atPlaceholderIndex)
        .concat(["${", expression, "}" + suffix])
        .concat(rest);
    }
    return Object.assign({}, doc, {
      parts: parts
    });
  });

  return expressions.length === replaceCounter ? newDoc : null;
}

/**
 * Template literal in this context:
 * <style jsx>{`div{color:red}`}</style>
 */
function isStyledJsx(path) {
  const node = path.getValue();
  const parent = path.getParentNode();
  const parentParent = path.getParentNode(1);
  return (
    parentParent &&
    node.quasis &&
    parent.type === "JSXExpressionContainer" &&
    parentParent.type === "JSXElement" &&
    parentParent.openingElement.name.name === "style" &&
    parentParent.openingElement.attributes.some(
      attribute => attribute.name.name === "jsx"
    )
  );
}

/**
 * styled-components template literals
 */
function isStyledComponents(path) {
  const parent = path.getParentNode();

  if (!parent || parent.type !== "TaggedTemplateExpression") {
    return false;
  }

  const tag = parent.tag;

  switch (tag.type) {
    case "MemberExpression":
      return (
        // styled.foo``
        isStyledIdentifier(tag.object) ||
        // Component.extend``
        isStyledExtend(tag)
      );

    case "CallExpression":
      return (
        // styled(Component)``
        isStyledIdentifier(tag.callee) ||
        (tag.callee.type === "MemberExpression" &&
          ((tag.callee.object.type === "MemberExpression" &&
            // styled.foo.attr({})``
            (isStyledIdentifier(tag.callee.object.object) ||
              // Component.extend.attr({)``
              isStyledExtend(tag.callee.object))) ||
            // styled(Component).attr({})``
            (tag.callee.object.type === "CallExpression" &&
              isStyledIdentifier(tag.callee.object.callee))))
      );

    case "Identifier":
      // css``
      return tag.name === "css";

    default:
      return false;
  }
}

/**
 * JSX element with CSS prop
 */
function isCssProp(path) {
  const parent = path.getParentNode();
  const parentParent = path.getParentNode(1);
  return (
    parentParent &&
    parent.type === "JSXExpressionContainer" &&
    parentParent.type === "JSXAttribute" &&
    parentParent.name.type === "JSXIdentifier" &&
    parentParent.name.name === "css"
  );
}

function isStyledIdentifier(node) {
  return node.type === "Identifier" && node.name === "styled";
}

function isStyledExtend(node) {
  return /^[A-Z]/.test(node.object.name) && node.property.name === "extend";
}

function hasLanguageComment(node, languageName) {
  // This checks for a leading comment that is exactly `/* GraphQL */`
  // In order to be in line with other implementations of this comment tag
  // we will not trim the comment value and we will expect exactly one space on
  // either side of the GraphQL string
  // Also see ./clean.js
  return hasLeadingComment(
    node,
    comment => isBlockComment(comment) && comment.value === ` ${languageName} `
  );
}

function isPathMatch(path, predicateStack) {
  const stack = path.stack.slice();

  let name = null;
  let node = stack.pop();

  for (const predicate of predicateStack) {
    if (node === undefined) {
      return false;
    }

    // skip index/array
    if (typeof name === "number") {
      name = stack.pop();
      node = stack.pop();
    }

    if (!predicate(node, name)) {
      return false;
    }

    name = stack.pop();
    node = stack.pop();
  }

  return true;
}

/**
 *     - html`...`
 *     - HTML comment block
 */
function isHtml(path) {
  const node = path.getValue();
  return (
    hasLanguageComment(node, "HTML") ||
    isPathMatch(path, [
      node => node.type === "TemplateLiteral",
      (node, name) =>
        node.type === "TaggedTemplateExpression" &&
        node.tag.type === "Identifier" &&
        node.tag.name === "html" &&
        name === "quasi"
    ])
  );
}

function printHtmlTemplateLiteral(path, print, textToDoc, parser) {
  const node = path.getValue();

  const placeholderPattern = "PRETTIER_HTML_PLACEHOLDER_(\\d+)_IN_JS";
  const placeholders = node.expressions.map(
    (_, i) => `PRETTIER_HTML_PLACEHOLDER_${i}_IN_JS`
  );

  const text = node.quasis
    .map((quasi, index, quasis) =>
      index === quasis.length - 1
        ? quasi.value.raw
        : quasi.value.raw + placeholders[index]
    )
    .join("");

  const expressionDocs = path.map(print, "expressions");

  if (expressionDocs.length === 0 && text.trim().length === 0) {
    return "``";
  }

  const contentDoc = mapDoc(
    stripTrailingHardline(textToDoc(text, { parser })),
    doc => {
      const placeholderRegex = new RegExp(placeholderPattern, "g");
      const hasPlaceholder =
        typeof doc === "string" && placeholderRegex.test(doc);

      if (!hasPlaceholder) {
        return doc;
      }

      const parts = [];

      const components = doc.split(placeholderRegex);
      for (let i = 0; i < components.length; i++) {
        const component = components[i];

        if (i % 2 === 0) {
          if (component) {
            parts.push(component);
          }
          continue;
        }

        const placeholderIndex = +component;
        parts.push(
          concat(["${", group(expressionDocs[placeholderIndex]), "}"])
        );
      }

      return concat(parts);
    }
  );

  return group(
    concat(["`", indent(concat([hardline, group(contentDoc)])), softline, "`"])
  );
}

module.exports = embed;
