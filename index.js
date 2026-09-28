/**
 * The dsh-xl bundle entry point: the `xl` Host service and its model-facing
 * `xl_*` tools.
 *
 * @module dsh-xl
 */

export { XL_SERVICE, apply, inject, name, normalizeConfig } from './src/plugin/index.js'
export { createXlService } from './src/plugin/service.js'
export { TOOL_NAMES, registerTools } from './src/plugin/tools.js'
