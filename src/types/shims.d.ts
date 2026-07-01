// Ambient module shims for dependencies that ship no type declarations.
// turndown / turndown-plugin-gfm are typed as `any` (used only inside the
// node-free conversion layer). Keeps both the NodeNext CLI build and the
// Bundler plugin typecheck happy.
declare module "turndown";
declare module "turndown-plugin-gfm";
