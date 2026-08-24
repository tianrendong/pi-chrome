function resolveChromeBackground(params, backgroundDefault, backgroundLocked) {
  const input = params || {};
  const explicit =
    input.background !== undefined
      ? input.background
      : input.foreground !== undefined
        ? !input.foreground
        : undefined;
  const background = backgroundLocked ? true : explicit ?? backgroundDefault;
  return { ...input, foreground: !background };
}

module.exports = { resolveChromeBackground };
