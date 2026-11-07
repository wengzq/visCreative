/** Tool-side inputs is shorthand for protocol inputNodeIds; normalize before protocol validation. */
export function normalizeCanvasInputs(params: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(params.ops)) return params
  return { ...params, ops: params.ops.map(op => {
    if (!op || typeof op !== 'object' || op.op !== 'node.create' || !Object.hasOwn(op, 'inputs')) return op
    if (op.inputNodeIds !== undefined) throw new Error('inputs and inputNodeIds cannot both be provided')
    const { inputs, ...rest } = op
    return { ...rest, inputNodeIds: inputs }
  }) }
}
