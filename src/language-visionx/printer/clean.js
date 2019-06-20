"use strict";

function clean(ast, newObj) {
  [
    "range",
    "raw",
    "comments",
    "leadingComments",
    "trailingComments",
    "extra",
    "start",
    "end",
    "flags"
  ].forEach(name => {
    delete newObj[name];
  });

  // We move text around, including whitespaces and add {" "}
  if (ast.type === "JSXText") {
    return null;
  }
  if (
    ast.type === "JSXExpressionContainer" &&
    ast.expression.type === "Literal" &&
    ast.expression.value === " "
  ) {
    return null;
  }

  // We convert <div></div> to <div />
  if (ast.type === "JSXOpeningElement") {
    delete newObj.selfClosing;
  }
  if (ast.type === "JSXElement") {
    delete newObj.closingElement;
  }

  // Remove raw and cooked values from TemplateElement when it's CSS
  // styled-jsx
  if (
    ast.type === "JSXElement" &&
    ast.openingElement.name.name === "style" &&
    ast.openingElement.attributes.some(attr => attr.name.name === "jsx")
  ) {
    const templateLiterals = newObj.children
      .filter(
        child =>
          child.type === "JSXExpressionContainer" &&
          child.expression.type === "TemplateLiteral"
      )
      .map(container => container.expression);

    const quasis = templateLiterals.reduce(
      (quasis, templateLiteral) => quasis.concat(templateLiteral.quasis),
      []
    );

    quasis.forEach(q => delete q.value);
  }

  // CSS template literals in css prop
  if (
    ast.type === "JSXAttribute" &&
    ast.name.name === "css" &&
    ast.value.type === "JSXExpressionContainer" &&
    ast.value.expression.type === "TemplateLiteral"
  ) {
    newObj.value.expression.quasis.forEach(q => delete q.value);
  }
}

module.exports = clean;
