const BROWSER_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function browserProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of BROWSER_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) allowed[name] = value;
  }
  return allowed;
}
