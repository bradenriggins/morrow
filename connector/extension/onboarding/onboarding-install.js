export function shouldOpenSetupOnInstall(details) {
  return details?.reason === "install";
}
