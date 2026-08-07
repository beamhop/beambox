export { DockerfileParseError, UnsupportedInstructionError } from "./errors.ts"
export {
  type LexResult,
  type LogicalLine,
  lex,
  parseExecForm,
  splitWords,
  takeFlags,
} from "./lexer.ts"
export { parseDockerfile } from "./parser.ts"
