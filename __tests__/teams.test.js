const {test} = require('node:test')
const assert = require('node:assert')
const {getExistingTeamAndMembers} = require('../lib/teams')

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function fakeClient({getByName, listMembersInOrg}) {
  return {teams: {getByName, listMembersInOrg}}
}

test('returns the team and its members when the team exists', async () => {
  const client = fakeClient({
    getByName: async () => ({data: {id: 1, slug: 'platform'}}),
    listMembersInOrg: async () => ({data: [{login: 'alice'}, {login: 'bob'}]})
  })

  const result = await getExistingTeamAndMembers(client, 'apolloio', 'platform')

  assert.deepStrictEqual(result, {
    existingTeam: {id: 1, slug: 'platform'},
    existingMembers: ['alice', 'bob']
  })
})

test('treats a 404 from getByName as a missing team', async () => {
  const client = fakeClient({
    getByName: async () => {
      throw httpError(404, 'Not Found')
    },
    listMembersInOrg: async () => assert.fail('should not list members of a missing team')
  })

  const result = await getExistingTeamAndMembers(client, 'apolloio', 'platform')

  assert.deepStrictEqual(result, {existingTeam: null, existingMembers: []})
})

for (const status of [500, 502, 403]) {
  test(`rethrows a ${status} from getByName instead of treating the team as missing`, async () => {
    const error = httpError(status, 'transient')
    const client = fakeClient({
      getByName: async () => {
        throw error
      },
      listMembersInOrg: async () => ({data: []})
    })

    await assert.rejects(getExistingTeamAndMembers(client, 'apolloio', 'platform'), error)
  })
}

test('rethrows a network error with no status from getByName', async () => {
  const error = new Error('socket hang up')
  const client = fakeClient({
    getByName: async () => {
      throw error
    },
    listMembersInOrg: async () => ({data: []})
  })

  await assert.rejects(getExistingTeamAndMembers(client, 'apolloio', 'platform'), error)
})

test('rethrows when listing members of an existing team fails', async () => {
  const error = httpError(502, 'Bad Gateway')
  const client = fakeClient({
    getByName: async () => ({data: {id: 1, slug: 'platform'}}),
    listMembersInOrg: async () => {
      throw error
    }
  })

  await assert.rejects(getExistingTeamAndMembers(client, 'apolloio', 'platform'), error)
})
