// The workflow domain's operations: templates as copy sources,
// whole-or-nothing application with slot resolution and the
// responsible-lawyer fallback, stage movement under the one-current rule,
// tasks and key dates under the no-carve-outs closed-matter ceremony,
// anchor values raising recompute proposals, and staffing-driven slot
// re-resolution — both proposal kinds decided through one-run bulk
// operations with undo windows.

export {
  createWorkflowTemplate,
  replaceTemplateStages,
  setWorkflowTemplateActive,
} from './templates'
export type { DueRule, TemplateStageInput, TemplateTaskInput } from './templates'
export {
  applyTemplateToMatter,
  applyTemplateInTx,
  enterStage,
  completeStage,
  reopenStage,
} from './apply'
export {
  createTask,
  setTaskDone,
  editTask,
  softDeleteTask,
  restoreTask,
  createKeyDate,
  setKeyDateDone,
  setKeyDateCritical,
} from './tasks'
export {
  setAnchorValue,
  decideRecomputeProposal,
  raiseSlotReresolutionInTx,                                            // hook body
  decideSlotProposal,
  createAnchorDefinition,
} from './anchors'
export { applyTemplateIfAny, fireSlotReresolution } from './hooks'
