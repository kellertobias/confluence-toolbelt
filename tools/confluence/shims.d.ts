declare module "turndown" {
  interface Options { headingStyle?: string; codeBlockStyle?: string }
  export default class TurndownService {
    constructor(options?: Options)
    use(plugin: any): void
    turndown(html: string): string
  }
}

declare module "turndown-plugin-gfm" {
  export const gfm: any
}


