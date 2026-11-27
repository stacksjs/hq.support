// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import { fail } from '../app/Support/errors'

const schemaNamespace = 'urn:ietf:params:scim:schemas:core:2.0:'
const listResponse = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'

interface AttributeOptions {
  multiValued?: boolean
  required?: boolean
  caseExact?: boolean
  mutability?: 'readOnly' | 'readWrite' | 'immutable'
  uniqueness?: 'none' | 'server'
  subAttributes?: ScimAttribute[]
}

interface ScimAttribute extends AttributeOptions {
  name: string
  type: 'string' | 'boolean' | 'complex'
  description: string
  returned: 'default'
}

function attribute(name: string, type: ScimAttribute['type'], description: string, options: AttributeOptions = {}): ScimAttribute {
  return {
    name,
    type,
    description,
    multiValued: false,
    required: false,
    ...(type === 'string' ? { caseExact: false } : {}),
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...options,
  }
}

const externalId = attribute('externalId', 'string', 'Directory identifier scoped to this identity provider.', { caseExact: true, mutability: 'immutable' })

const resources = [
  {
    name: 'User',
    endpoint: '/Users',
    description: 'Provisioned workspace membership.',
    attributes: [
      externalId,
      attribute('userName', 'string', 'Email address of the workspace membership.', { required: true, mutability: 'immutable', uniqueness: 'server' }),
      attribute('active', 'boolean', 'Whether the directory allows this membership to be active.'),
    ],
  },
  {
    name: 'Group',
    endpoint: '/Groups',
    description: 'Directory group scoped to the workspace and identity provider.',
    attributes: [
      externalId,
      attribute('displayName', 'string', 'Name of the directory group.', { required: true, caseExact: true }),
      attribute('members', 'complex', 'Provisioned users in this directory group.', {
        multiValued: true,
        subAttributes: [
          attribute('value', 'string', 'ID of a provisioned user in this directory.', { required: true, caseExact: true, mutability: 'immutable' }),
          attribute('display', 'string', 'Email address of the provisioned user.', { mutability: 'readOnly' }),
        ],
      }),
    ],
  },
]

export function scimDiscovery(endpoint: 'Schemas' | 'ResourceTypes', workspaceId: number, reference: string | undefined, hasFilter: boolean) {
  if (hasFilter)
    fail(403, 'invalidFilter', 'SCIM discovery does not support filters.')

  const collection = `/api/scim/v2/${workspaceId}/${endpoint}`
  const entries = resources.map((resource) => {
    const schema = schemaNamespace + resource.name
    if (endpoint === 'Schemas') {
      return {
        schemas: [schemaNamespace + 'Schema'],
        id: schema,
        name: resource.name,
        description: resource.description,
        attributes: resource.attributes,
        meta: { resourceType: 'Schema', location: `${collection}/${schema}` },
      }
    }
    return {
      schemas: [schemaNamespace + 'ResourceType'],
      id: resource.name,
      name: resource.name,
      description: resource.description,
      endpoint: resource.endpoint,
      schema,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${collection}/${resource.name}` },
    }
  })

  if (reference) {
    const entry = entries.find(entry => entry.id === reference || encodeURIComponent(entry.id) === reference)
    if (!entry)
      fail(404, 'not_found', 'SCIM discovery resource not found.')
    return entry
  }
  return { schemas: [listResponse], totalResults: entries.length, startIndex: 1, itemsPerPage: entries.length, Resources: entries }
}
