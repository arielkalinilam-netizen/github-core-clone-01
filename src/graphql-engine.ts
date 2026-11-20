// A tiny GraphQL executor for the forge's v4 endpoint. No GraphQL library: a recursive-descent parser
// for the subset the conformance suite sends (queries, mutations, aliases, variables, inline objects,
// enum values, lists, `... on Type` inline fragments) and a hand-built schema used both to execute and
// to validate unknown fields (an unknown field is a 200 with an errors entry naming the field).

// ---------------------------------------------------------------- lexer + parser

interface Token {
  kind: 'name' | 'punct';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === ',' ) { i += 1; continue; }
    if ('{}()[]:$='.includes(ch)) { tokens.push({ kind: 'punct', text: ch }); i += 1; continue; }
    if (ch === '.' ) {
      if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', text: '...' }); i += 3; continue; }
      i += 1; continue;
    }
    if (ch === '"') {
      // Block or ordinary strings never appear in the suite's documents; skip either.
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') { j += 2; continue; }
        text += source[j];
        j += 1;
      }
      tokens.push({ kind: 'name', text: `__STRING__${text}` });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[\w_]/.test(source[j]!)) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push({ kind: 'name', text: source.slice(i, j) });
    i = j;
  }
  return tokens;
}

export interface Value {
  kind: 'var' | 'string' | 'int' | 'float' | 'bool' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  values?: Value[];
  fields?: Array<{ name: string; value: Value }>;
}

export interface Argument {
  name: string;
  value: Value;
}

export interface Field {
  kind: 'field';
  alias?: string;
  name: string;
  arguments: Argument[];
  selections: Selection[];
}

export type Selection =
  | Field
  | { kind: 'inlineFragment'; typeCondition?: string; selections: Selection[] };

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variableDefinitions: Array<{ name: string; type: string; hasDefault?: boolean; defaultValue?: Value }>;
  selections: Selection[];
}

export interface ParsedDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private expect(text: string): void {
    const token = this.next();
    if (!token || token.text !== text) throw new ParseError(`expected ${text}, got ${token?.text ?? 'end'}`);
  }
  private optional(text: string): boolean {
    if (this.peek()?.text === text) { this.pos += 1; return true; }
    return false;
  }

  document(): ParsedDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selections: Selection[] }>();
    while (this.peek() !== undefined) {
      const token = this.next()!;
      if (token.text === '{') {
        this.pos -= 1; // let selectionSet consume the brace
        operations.push({ kind: 'query', variableDefinitions: [], selections: this.selectionSet() });
        continue;
      }
      if (token.kind !== 'name') continue;
      if (token.text === 'fragment') {
        const name = this.next()!.text;
        this.expect('on');
        const typeCondition = this.next()!.text;
        fragments.set(name, { typeCondition, selections: this.selectionSet() });
        continue;
      }
      const kind = token.text === 'query' ? 'query' : token.text === 'mutation' ? 'mutation' : null;
      if (kind === null) continue;
      let name: string | undefined;
      if (this.peek()?.kind === 'name') name = this.next()!.text;
      const variableDefinitions: Operation['variableDefinitions'] = [];
      if (this.optional('(')) {
        while (!this.optional(')')) {
          this.expect('$');
          const varName = this.next()!.text;
          this.expect(':');
          variableDefinitions.push({ name: varName, type: this.typeRef() });
        }
      }
      // Skip optional directives/used-at names.
      while (this.peek()?.kind === 'name' && ['@'].includes(this.tokens[this.pos]!.text[0]!)) this.next();
      if (this.peek()?.text === '@') { this.next(); if (this.peek()?.kind === 'name') this.next(); if (this.optional('(')) this.skipBalanced('(', ')'); }
      const selections = this.selectionSet();
      operations.push({ kind, name, variableDefinitions, selections });
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0 && this.peek() !== undefined) {
      const text = this.next()!.text;
      if (text === open) depth += 1;
      else if (text === close) depth -= 1;
    }
  }

  private typeRef(): string {
    let type = '';
    if (this.optional('[')) { type = `[${this.typeRef()}]`; }
    else type = this.next()!.text;
    if (this.optional('!')) type += '!';
    return type;
  }

  selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.optional('}')) {
      const token = this.next()!;
      if (token.text === '...') {
        if (this.peek()?.kind === 'name' && this.peek()!.text !== 'on') {
          // Named fragment spread: expand later.
          selections.push({ kind: 'inlineFragment', typeCondition: `__spread:${this.next()!.text}`, selections: [] });
        } else {
          this.optional('on');
          const typeCondition = this.peek()?.kind === 'name' ? this.next()!.text : undefined;
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.selectionSet() });
        }
        continue;
      }
      let name = token.text;
      let alias: string | undefined;
      if (this.optional(':')) {
        alias = name;
        name = this.next()!.text;
      }
      const arguments_: Argument[] = [];
      if (this.optional('(')) {
        while (!this.optional(')')) {
          if (this.peek()?.text === '$') this.next();
          const argName = this.next()!.text;
          this.expect(':');
          arguments_.push({ name: argName, value: this.value() });
        }
      }
      // Directives
      while (this.peek()?.text === '@') {
        this.next();
        if (this.peek()?.kind === 'name') this.next();
        if (this.optional('(')) this.skipBalanced('(', ')');
      }
      const nested: Selection[] = this.peek()?.text === '{' ? this.selectionSet() : [];
      selections.push({ kind: 'field', alias, name, arguments: arguments_, selections: nested });
    }
    return selections;
  }

  value(): Value {
    const token = this.next()!;
    if (token.text === '$') return { kind: 'var', value: this.next()!.text };
    if (token.text === '[') {
      const values: Value[] = [];
      while (!this.optional(']')) values.push(this.value());
      return { kind: 'list', values };
    }
    if (token.text === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.optional('}')) {
        const name = this.next()!.text;
        this.expect(':');
        fields.push({ name, value: this.value() });
      }
      return { kind: 'object', fields };
    }
    if (token.text.startsWith('__STRING__')) return { kind: 'string', value: token.text.slice('__STRING__'.length) };
    if (token.text === 'true') return { kind: 'bool', value: true };
    if (token.text === 'false') return { kind: 'bool', value: false };
    if (token.text === 'null') return { kind: 'null' };
    if (/^-?\d+(\.\d+)?$/.test(token.text)) {
      return token.text.includes('.') ? { kind: 'float', value: Number(token.text) } : { kind: 'int', value: Number(token.text) };
    }
    return { kind: 'enum', value: token.text };
  }
}

export class ParseError extends Error {}

/** Parse one operation document. */
export function parseDocument(source: string): ParsedDocument {
  return new Parser(tokenize(source)).document();
}

// ---------------------------------------------------------------- execution

export interface ExecutionContext {
  variables: Record<string, unknown>;
  fragments: ParsedDocument['fragments'];
  schema: Record<string, SchemaType>;
  root: ResolverMap;
  errors: string[];
}

export type ResolverMap = Record<string, unknown> & { __typename?: string };

/** A schema type: field name -> field schema (type kind + whether it takes `first`). */
export interface SchemaField {
  type: 'scalar' | 'object' | 'list';
  of?: string; // object type name for object/list
  args?: string[];
}

export interface SchemaType {
  fields: Record<string, SchemaField>;
}

function resolveValue(value: Value, context: ExecutionContext): unknown {
  switch (value.kind) {
    case 'var': return context.variables[value.value as string];
    case 'string': case 'int': case 'float': case 'bool': case 'enum': return value.value;
    case 'null': return null;
    case 'list': return (value.values ?? []).map((entry) => resolveValue(entry, context));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields ?? []) out[field.name] = resolveValue(field.value, context);
      return out;
    }
  }
}

function resolveArguments(fields: Argument[], context: ExecutionContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const argument of fields) out[argument.name] = resolveValue(argument.value, context);
  return out;
}

/** Execute a selection set against `source`; answers a plain JSON object (or array/scalar). */
export function executeSelections(
  selections: Selection[],
  source: ResolverMap | null,
  parentTypeName: string,
  context: ExecutionContext,
): unknown {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of expand(selections, context, parentTypeName)) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    const typeSchema = context.schema[parentTypeName];
    const fieldSchema = typeSchema?.fields[selection.name];
    if (fieldSchema === undefined) {
      context.errors.push(`Field '${selection.name}' does not exist on type '${parentTypeName}'.`);
      out[key] = null;
      continue;
    }
    const args = resolveArguments(selection.arguments, context);
    const resolver = source[selection.name];
    let value: unknown;
    if (typeof resolver === 'function') {
      value = (resolver as (args: Record<string, unknown>) => unknown)(args);
    } else {
      value = resolver;
    }
    if (value === undefined) value = null;
    if (selection.selections.length > 0) {
      if (fieldSchema.type === 'list') {
        const list = Array.isArray(value) ? value : [];
        value = list.map((entry) => (entry === null || entry === undefined ? null : executeSelections(selection.selections, entry as ResolverMap, fieldSchema.of ?? parentTypeName, context)));
      } else if (fieldSchema.type === 'object') {
        if (value === null) { out[key] = null; continue; }
        const runtimeType = (value as ResolverMap).__typename;
        value = executeSelections(selection.selections, value as ResolverMap, runtimeType ?? fieldSchema.of ?? parentTypeName, context);
      }
    }
    out[key] = value;
  }
  return out;
}

function expand(selections: Selection[], context: ExecutionContext, parentType: string): Selection[] {
  const out: Selection[] = [];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition ?? '';
      if (condition.startsWith('__spread:')) {
        const fragment = context.fragments.get(condition.slice('__spread:'.length));
        if (fragment) out.push(...expand(fragment.selections, context, parentType));
        continue;
      }
      if (condition === undefined || condition === parentType) {
        out.push(...expand(selection.selections, context, parentType));
      }
      continue;
    }
    out.push(selection);
  }
  return out;
}

export interface OperationResult {
  data: Record<string, unknown> | null;
  errors: string[];
}

/** Run one parsed operation's first matching operation (or the only one). */
export function executeOperation(
  document: ParsedDocument,
  operationName: string | undefined,
  variables: Record<string, unknown>,
  root: ResolverMap,
  schema: Record<string, SchemaType>,
): OperationResult {
  const operation = operationName
    ? document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (!operation) return { data: null, errors: ['no operation in document'] };
  const context: ExecutionContext = { variables, fragments: document.fragments, schema, root, errors: [] };
  const rootTypeName = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, root, rootTypeName, context);
  return { data: (data ?? null) as Record<string, unknown> | null, errors: context.errors };
}

// ---------------------------------------------------------------- the forge schema

const REPOSITORY_FIELDS: Record<string, SchemaField> = {
  id: { type: 'scalar' },
  databaseId: { type: 'scalar' },
  name: { type: 'scalar' },
  nameWithOwner: { type: 'scalar' },
  owner: { type: 'object', of: 'User' },
  defaultBranchRef: { type: 'object', of: 'Ref' },
  viewerPermission: { type: 'scalar' },
  hasIssuesEnabled: { type: 'scalar' },
  issue: { type: 'object', of: 'Issue' },
  issues: { type: 'object', of: 'IssueConnection' },
  pullRequests: { type: 'object', of: 'PullRequestConnection' },
  pullRequest: { type: 'object', of: 'PullRequest' },
  files: { type: 'object', of: 'PullRequestChangedFileConnection' },
  labels: { type: 'object', of: 'LabelConnection' },
};

export const SCHEMA: Record<string, SchemaType> = {
  Query: {
    fields: {
      viewer: { type: 'object', of: 'User' },
      repository: { type: 'object', of: 'Repository' },
      node: { type: 'object', of: 'Node' },
      __type: { type: 'object', of: '__Type' },
      __schema: { type: 'object', of: '__Schema' },
    },
  },
  Mutation: {
    fields: {
      createIssue: { type: 'object', of: 'CreateIssuePayload' },
      closeIssue: { type: 'object', of: 'CloseIssuePayload' },
      createPullRequest: { type: 'object', of: 'CreatePullRequestPayload' },
      mergePullRequest: { type: 'object', of: 'MergePullRequestPayload' },
      addComment: { type: 'object', of: 'AddCommentPayload' },
      updateIssue: { type: 'object', of: 'CloseIssuePayload' },
    },
  },
  User: { fields: { id: { type: 'scalar' }, login: { type: 'scalar' }, name: { type: 'scalar' }, createdAt: { type: 'scalar' }, url: { type: 'scalar' } } },
  Repository: { fields: REPOSITORY_FIELDS },
  Issue: { fields: { id: { type: 'scalar' }, number: { type: 'scalar' }, title: { type: 'scalar' }, state: { type: 'scalar' }, body: { type: 'scalar' }, createdAt: { type: 'scalar' }, updatedAt: { type: 'scalar' }, closedAt: { type: 'scalar' }, author: { type: 'object', of: 'User' }, repository: { type: 'object', of: 'Repository' }, comments: { type: 'object', of: 'IssueCommentConnection' } } },
  IssueConnection: { fields: { nodes: { type: 'list', of: 'Issue' }, pageInfo: { type: 'object', of: 'PageInfo' }, totalCount: { type: 'scalar' } } },
  IssueComment: { fields: { id: { type: 'scalar' }, body: { type: 'scalar' }, createdAt: { type: 'scalar' }, author: { type: 'object', of: 'User' } } },
  IssueCommentConnection: { fields: { nodes: { type: 'list', of: 'IssueComment' }, totalCount: { type: 'scalar' } } },
  PullRequest: { fields: { id: { type: 'scalar' }, number: { type: 'scalar' }, state: { type: 'scalar' }, merged: { type: 'scalar' }, mergedAt: { type: 'scalar' }, headRefName: { type: 'scalar' }, baseRefName: { type: 'scalar' }, mergeable: { type: 'scalar' }, title: { type: 'scalar' }, body: { type: 'scalar' }, createdAt: { type: 'scalar' }, files: { type: 'object', of: 'PullRequestChangedFileConnection' }, author: { type: 'object', of: 'User' }, repository: { type: 'object', of: 'Repository' } } },
  PullRequestConnection: { fields: { nodes: { type: 'list', of: 'PullRequest' }, totalCount: { type: 'scalar' }, pageInfo: { type: 'object', of: 'PageInfo' } } },
  PullRequestChangedFile: { fields: { path: { type: 'scalar' }, additions: { type: 'scalar' }, deletions: { type: 'scalar' } } },
  PullRequestChangedFileConnection: { fields: { nodes: { type: 'list', of: 'PullRequestChangedFile' } } },
  Ref: { fields: { name: { type: 'scalar' }, id: { type: 'scalar' } } },
  PageInfo: { fields: { hasNextPage: { type: 'scalar' }, endCursor: { type: 'scalar' }, hasPreviousPage: { type: 'scalar' }, startCursor: { type: 'scalar' } } },
  Node: { fields: { id: { type: 'scalar' }, ...REPOSITORY_FIELDS, ...{ number: { type: 'scalar' }, title: { type: 'scalar' }, state: { type: 'scalar' }, body: { type: 'scalar' } } } },
  CreateIssuePayload: { fields: { issue: { type: 'object', of: 'Issue' } } },
  CloseIssuePayload: { fields: { issue: { type: 'object', of: 'Issue' } } },
  CreatePullRequestPayload: { fields: { pullRequest: { type: 'object', of: 'PullRequest' } } },
  MergePullRequestPayload: { fields: { pullRequest: { type: 'object', of: 'PullRequest' } } },
  AddCommentPayload: { fields: { commentEdge: { type: 'object', of: 'CommentEdge' } } },
  CommentEdge: { fields: { node: { type: 'object', of: 'IssueComment' } } },
  __Type: {
    fields: {
      name: { type: 'scalar' },
      kind: { type: 'scalar' },
      fields: { type: 'list', of: '__Field' },
      enumValues: { type: 'list', of: '__EnumValue' },
      ofType: { type: 'object', of: '__Type' },
    },
  },
  __Field: { fields: { name: { type: 'scalar' }, description: { type: 'scalar' }, isDeprecated: { type: 'scalar' }, deprecationReason: { type: 'scalar' }, type: { type: 'object', of: '__Type' }, args: { type: 'list', of: '__InputValue' } } },
  __EnumValue: { fields: { name: { type: 'scalar' }, isDeprecated: { type: 'scalar' }, deprecationReason: { type: 'scalar' } } },
  __InputValue: { fields: { name: { type: 'scalar' }, defaultValue: { type: 'scalar' }, type: { type: 'object', of: '__Type' } } },
  __Schema: { fields: { queryType: { type: 'object', of: '__Type' }, types: { type: 'list', of: '__Type' } } },
};

/** The field names and enum values the introspection probes must list. */
export const INTROSPECTION: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'comments'] },
  PullRequest: { fields: ['id', 'number', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'title', 'body', 'files', 'author', 'createdAt', 'repository'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'description'] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { fields: [], enumValues: ['ASC', 'DESC'] },
};
