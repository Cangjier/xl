/**
 * The xl core library: the parser, the checker, the deterministic ts printer,
 * planning, the cache, and the artifact contract, re-exported as one module.
 *
 * Nothing here reaches the network or spawns a process. The only I/O is the
 * filesystem work in `build`, `scan`, `cache`, and `source`, which the Host
 * plugin calls on behalf of an agent.
 *
 * @module dsh-xl/core
 */

export { BuildCache } from './cache.js'
export {
  contextFor,
  emitArtifacts,
  loadEntry,
  resolveArtifactRequest,
  verifyArtifacts,
} from './artifact.js'
export {
  buildPrepared,
  checkWorkspace,
  languageContext,
  planWorkspace,
  prepareWorkspace,
  resolveRequestedTargets,
  runBuild,
  runCheck,
  runPlan,
} from './build.js'
export { checkDeclaredTargets, checkDocument, languageNamesOf, overrideSections } from './check.js'
export { cacheRoot, DEFAULTS, deepMerge, envConfig, findConfigFile, loadConfig, resolveBuildOptions } from './config.js'
export {
  countBySeverity,
  dedupeDiagnostics,
  diag,
  DIAG_CODES,
  helpOf,
  severityOf,
  sortDiagnostics,
  USAGE_CODES,
} from './diagnostics.js'
export {
  commentMarkerFor,
  exportedNamesOf,
  indexAssign,
  isKnownLanguage,
  LANGUAGE_NAMES,
  MEMBER_KEYWORDS,
  MODIFIER_KEYWORDS,
  MODULE_SECTION_KINDS,
  parseImportLine,
  parseXlMd,
  SECTION_KEYWORDS,
  TYPE_SECTION_KINDS,
} from './parse.js'
export {
  printTypeScriptBody,
  printTypeScriptFile,
  renderDecl,
  rewriteImportPath,
  XL_VERSION,
} from './emit-ts.js'
export {
  fingerprintArtifact,
  fingerprintPrompt,
  fingerprintSource,
  isArtifact,
  parseArtifactHeader,
  renderHeader,
} from './header.js'
export { detectConflicts, outputRoot, planSource, sourceBaseName } from './plan.js'
export {
  collectSources,
  expandBraces,
  globToRegExp,
  isGlob,
  isIgnored,
  matchesAny,
  readIgnorePatterns,
  SCAN_EXCLUDES,
  SOURCE_SUFFIX,
} from './scan.js'
export { loadSource, positionOf } from './source.js'
export {
  BUILTIN_TARGETS,
  canonicalLang,
  LAYOUT_FILE,
  LAYOUT_TYPE,
  listTargets,
  MODULE_FILE_SUFFIX,
  resolveLayout,
  resolveTarget,
  resolveTargets,
  SOURCE_LANG,
  TARGET_ALIASES,
  typeFileBaseName,
  UsageError,
} from './targets.js'
export {
  bodyHasYield,
  HEADER_MARK,
  INDENT,
  isIdentifier,
  normalizeCode,
  normalizeNewlines,
  proseOf,
  sha256,
  splitTopLevel,
  toPosix,
} from './text.js'
export {
  collectTypeNames,
  generatorOf,
  mapType,
  parseType,
  promiseOf,
  typeHasName,
} from './types.js'
export { declaredTypeNames, parameterCounts, structureSummary, verifyStructure } from './verify.js'
