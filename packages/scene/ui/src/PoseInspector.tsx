import type { Vec3 } from '@vis/protocol'
import {
  jointEuler, mirrorPose, pairedJoints, poseRotation, presetPose, resetJointPose, setJointAxis,
  type BodyDescriptor, type BodyPose,
} from '@vis/scene-core'
import { useMessages } from '@vis/ui-kit'
import { useState } from 'react'
import { MathUtils } from 'three'
import { NumberField } from './fields'
import { sceneMessages } from './messages'
import type { SceneViewportController } from './types'
import { useSceneViewportState } from './viewport-state'

export function PoseInspector({ body, pose, controller, disabled, change }: {
  body: BodyDescriptor
  pose: BodyPose
  controller: SceneViewportController
  disabled: boolean
  change(update: (pose: BodyPose) => BodyPose): void
}) {
  const m = useMessages(sceneMessages)
  const state = useSceneViewportState(controller)
  const [presetId, setPresetId] = useState(body.poses[0]?.id ?? '')
  const selected = body.joints.find(joint => joint.id === state.selectedJointId)
  const degrees = selected ? jointEuler(poseRotation(body, pose, selected)).map(MathUtils.radToDeg) as Vec3 : null
  return <section className="vis-sc-inspector-section" aria-label={m.pose}>
    <h3>{m.pose}</h3>
    {body.poses.length ? <div className="vis-sc-preset">
      <label className="vis-sc-field">{m.presetPose}<select aria-label={m.presetPose} disabled={disabled} value={presetId} onChange={event => setPresetId(event.target.value)}>
        {body.poses.map(preset => <option key={preset.id} value={preset.id}>{m.poseName(preset.id)}</option>)}
      </select></label>
      <button aria-label={m.applyPose} disabled={disabled} onClick={() => change(() => presetPose(body, presetId))}>{m.applyPose}</button>
    </div> : null}
    <button aria-label={m.resetFigure} disabled={disabled} onClick={() => change(() => presetPose(body))}>{m.resetFigure}</button>
    {pairedJoints(body).length ? <fieldset className="vis-sc-mirror" disabled={disabled}>
      <legend>{m.mirrorPose}</legend>
      <div className="vis-sc-button-row">{(['leftToRight', 'rightToLeft', 'swap'] as const).map(direction =>
        <button key={direction} aria-label={m[direction]} onClick={() => change(pose => mirrorPose(body, pose, direction))}>{m[direction]}</button>,
      )}</div>
    </fieldset> : null}
    <h3 className="vis-sc-joints-heading">{m.joints}</h3>
    <ul className="vis-sc-joints" aria-label={m.joints}>
      {body.joints.map(joint => <li key={joint.id}><button aria-label={m.selectJoint(m.jointName(joint.id))} aria-pressed={joint.id === state.selectedJointId}
        disabled={disabled} onClick={() => controller.selectJoint(joint.id)}>{m.jointName(joint.id)}</button></li>)}
    </ul>
    {selected && degrees ? <fieldset className="vis-sc-transform vis-sc-joint-rotation" disabled={disabled}>
      <legend>{m.jointName(selected.id)}</legend>
      <div>{(['x', 'y', 'z'] as const).map((axis, index) => <NumberField key={`${selected.id}-${axis}`} label={m.jointRotation(m.jointName(selected.id), m[axis])} caption={m[axis]}
        value={degrees[index]!} disabled={disabled} min={MathUtils.radToDeg(selected.limits.min[index]!)} max={MathUtils.radToDeg(selected.limits.max[index]!)} commitOnBlur
        onChange={value => change(pose => ({ ...pose, [selected.id]: setJointAxis(selected, poseRotation(body, pose, selected), index as 0 | 1 | 2, MathUtils.degToRad(value)) }))} />)}</div>
    </fieldset> : null}
    {selected ? <div className="vis-sc-button-row">
      <button aria-label={m.resetJoint} disabled={disabled} onClick={() => change(pose => resetJointPose(body, pose, selected.id))}>{m.resetJoint}</button>
      <button aria-label={m.leaveJoint} disabled={disabled} onClick={() => controller.selectJoint(null)}>{m.leaveJoint}</button>
    </div> : null}
  </section>
}
