import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export default defineConfig({
  title: 'Portler',
  description: 'Local development process runner with automatic port assignment and env resolution.',
  base: '/Portler/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/Portler/logo.svg' }]],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-portler', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/configuration', activeMatch: '/reference/' },
      {
        text: `v${packageVersion}`,
        items: [
          { text: 'npm', link: 'https://www.npmjs.com/package/portler' },
          { text: 'Releases', link: 'https://github.com/YJJosh/Portler/releases' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Portler?', link: '/guide/what-is-portler' },
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Core concepts',
          items: [
            { text: 'Services & environment', link: '/guide/services' },
            { text: 'Ports', link: '/guide/ports' },
            { text: 'Dependencies & readiness', link: '/guide/dependencies' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Docker services', link: '/guide/docker' },
            { text: 'Volumes', link: '/guide/volumes' },
            { text: 'Proxy: one project URL', link: '/guide/proxy' },
            { text: 'Kubernetes mode', link: '/guide/kubernetes' },
          ],
        },
      ],

      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'portler.yml', link: '/reference/configuration' },
            { text: 'Environment variables', link: '/reference/environment' },
            { text: 'Generated files', link: '/reference/generated-files' },
          ],
        },
        {
          text: 'CLI commands',
          items: [
            { text: 'Overview', link: '/reference/cli/' },
            { text: 'portler up', link: '/reference/cli/up' },
            { text: 'portler down', link: '/reference/cli/down' },
            { text: 'portler restart', link: '/reference/cli/restart' },
            { text: 'portler ps', link: '/reference/cli/ps' },
            { text: 'portler logs', link: '/reference/cli/logs' },
            { text: 'portler ports', link: '/reference/cli/ports' },
            { text: 'portler env', link: '/reference/cli/env' },
            { text: 'portler clean', link: '/reference/cli/clean' },
            { text: 'portler volumes', link: '/reference/cli/volumes' },
            { text: 'portler k8s render', link: '/reference/cli/k8s-render' },
            { text: 'portler init', link: '/reference/cli/init' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/YJJosh/Portler' }],

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/YJJosh/Portler/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
    },

    outline: { level: [2, 3] },
  },
});
