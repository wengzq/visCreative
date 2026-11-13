import { expect, it } from 'vitest'
import { getGuide } from '@vis/workbench-core'
// Test the two sources together without adding a runtime dependency between their packages.
import { HUMAN_BODY } from '../../../packages/scene/core/src/descriptors'

it('keeps the scene guide joint ids and preset names exactly equal to the human body descriptor', () => {
  const body = getGuide('scene').guide!.body
  const listed = (label: string) => {
    const line = body.split('\n').find(line => line.startsWith(`${label}:`))!
    return [...line.matchAll(/`([^`]+)`/g)].map(match => match[1])
  }
  expect(listed('Human joint ids')).toEqual(HUMAN_BODY.joints.map(joint => joint.id))
  expect(listed('Human preset pose names')).toEqual(HUMAN_BODY.poses.map(pose => pose.id))
})


it('directs protected scene edits to reviewable proposals without retrying the write', () => {
  const body = getGuide('scene').guide!.body
  for (const reason of ['scene.object_protected', 'scene.view_protected', 'scene.duration_protected']) expect(body).toContain(reason)
  expect(body).toContain('call scene.propose')
  expect(body).toContain('Do not retry the write')
})
