import "node:sqlite";

declare module "node:sqlite" {
  interface StatementSync {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
  }
}
