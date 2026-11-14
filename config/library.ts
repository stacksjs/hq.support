import type { LibraryConfig } from '@stacksjs/types'

export default {
  name: 'hq-support',
  owner: '@stacksjs',
  repository: 'stacksjs/hq.support',
  license: 'MIT',
  author: 'Chris Breuer',
  contributors: ['Chris Breuer <chris@stacksjs.com>'],
  packages: [{
    name: '@stacksjs/support-elements',
    kind: 'web-components',
    description: 'Framework independent HQ.support messenger and support elements compiled from stx.',
    prefix: 'hq-support',
    include: ['support/*.stx'],
    registry: 'npm',
  }],
} satisfies LibraryConfig
