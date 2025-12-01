import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "ErrLookup Resources",
  tagline: "Deep dives into the errors you encounter every day",
  favicon: "img/favicon.ico",

  url: "https://errlookup.dev",
  baseUrl: "/",

  organizationName: "errlookup",
  projectName: "resources",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "ErrLookup",
      items: [
        {
          type: "docSidebar",
          sidebarId: "conceptsSidebar",
          position: "left",
          label: "Concepts",
        },
        {
          type: "docSidebar",
          sidebarId: "guidesSidebar",
          position: "left",
          label: "Guides",
        },
        {
          type: "docSidebar",
          sidebarId: "referenceSidebar",
          position: "left",
          label: "Reference",
        },
        {
          href: "https://github.com/errlookup",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Learn",
          items: [
            { label: "Concepts", to: "/concepts" },
            { label: "Guides", to: "/guides" },
            { label: "Reference", to: "/reference" },
          ],
        },
        {
          title: "Browse Errors",
          items: [
            { label: "All Projects", href: "/projects" },
            { label: "By Language", href: "/languages" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: "https://github.com/errlookup" },
            { label: "About", to: "/about" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} ErrLookup. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "go", "rust", "python", "java", "c", "cpp"],
    },
    algolia: {
      appId: "YOUR_APP_ID",
      apiKey: "YOUR_SEARCH_API_KEY",
      indexName: "errlookup",
      contextualSearch: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
