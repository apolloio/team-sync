const assert = require('assert')
const {fetchTeamIdsByName, resolveParentTeamId} = require('../lib/team-parent')

async function testPaginationAndParentResolution() {
  let paginateCalled = false
  const teams = Array.from({length: 101}, (_, index) => ({
    id: index + 1,
    name: index === 100 ? 'eng' : `team-${index + 1}`
  }))
  const client = {
    paginate: async (route, parameters) => {
      paginateCalled = true
      assert.strictEqual(route, 'GET /orgs/:org/teams')
      assert.deepStrictEqual(parameters, {org: 'apolloio', per_page: 100})
      return teams
    }
  }

  const teamIdsByName = await fetchTeamIdsByName(client, 'apolloio')

  assert.strictEqual(paginateCalled, true)
  assert.strictEqual(resolveParentTeamId('builder-studio', 'eng', teamIdsByName, 'apolloio'), 101)
}

function testMissingParentFailsSync() {
  assert.throws(
    () => resolveParentTeamId('builder-studio', 'eng', {}, 'apolloio'),
    /Parent team eng for builder-studio does not exist in apolloio/
  )
}

async function run() {
  await testPaginationAndParentResolution()
  testMissingParentFailsSync()
  process.stdout.write('team parent regression tests passed\n')
}

run().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
