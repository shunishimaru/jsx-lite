import dedent from 'dedent';
import json5 from 'json5';
import { format } from 'prettier/standalone';
import { functionLiteralPrefix } from '../constants/function-literal-prefix';
import { methodLiteralPrefix } from '../constants/method-literal-prefix';
import { stripStateAndPropsRefs } from '../helpers/strip-state-and-props-refs';
import {
  collectCss,
  collectStyledComponents,
  hasStyles,
} from '../helpers/collect-styles';
import { fastClone } from '../helpers/fast-clone';
import { getRefs } from '../helpers/get-refs';
import { getStateObjectString } from '../helpers/get-state-object-string';
import { mapRefs } from '../helpers/map-refs';
import { renderPreComponent } from '../helpers/render-imports';
import { selfClosingTags } from '../parsers/jsx';
import { JSXLiteComponent } from '../types/jsx-lite-component';
import { JSXLiteNode } from '../types/jsx-lite-node';
import traverse from 'traverse';
import { isJsxLiteNode } from '../helpers/is-jsx-lite-node';
import { babelTransformExpression } from '../helpers/babel-transform';
import { types } from '@babel/core';
import { filterEmptyTextNodes } from '../helpers/filter-empty-text-nodes';
import { gettersToFunctions } from '../helpers/getters-to-functions';
import {
  Plugin,
  runPostCodePlugins,
  runPostJsonPlugins,
  runPreCodePlugins,
  runPreJsonPlugins,
} from '../modules/plugins';
import { capitalize } from '../helpers/capitalize';

type ToReactOptions = {
  prettier?: boolean;
  stylesType?: 'emotion' | 'styled-components' | 'styled-jsx';
  stateType?: 'useState' | 'mobx' | 'valtio' | 'solid' | 'builder';
  plugins?: Plugin[];
};

const NODE_MAPPERS: {
  [key: string]: (json: JSXLiteNode, options: ToReactOptions) => string;
} = {
  Fragment(json, options) {
    return `<>${json.children
      .map((item) => blockToReact(item, options))
      .join('\n')}</>`;
  },
  For(json, options) {
    return `{${processBinding(json.bindings.each as string, options)}.map(${
      json.bindings._forName
    } => (
      <>${json.children
        .filter(filterEmptyTextNodes)
        .map((item) => blockToReact(item, options))
        .join('\n')}</>
    ))}`;
  },
  Show(json, options) {
    return `{Boolean(${processBinding(
      json.bindings.when as string,
      options,
    )}) && (
      <>${json.children
        .filter(filterEmptyTextNodes)
        .map((item) => blockToReact(item, options))
        .join('\n')}</>
    )}`;
  },
};

// TODO: Maybe in the future allow defining `string | function` as values
const BINDING_MAPPERS: {
  [key: string]: string | ((key: string, value: string) => [string, string]);
} = {
  innerHTML(_key, value) {
    return ['dangerouslySetInnerHTML', JSON.stringify({ __html: value })];
  },
};

const blockToReact = (json: JSXLiteNode, options: ToReactOptions) => {
  if (NODE_MAPPERS[json.name]) {
    return NODE_MAPPERS[json.name](json, options);
  }

  if (json.properties._text) {
    return json.properties._text;
  }
  if (json.bindings._text) {
    return `{${processBinding(json.bindings._text as string, options)}}`;
  }

  let str = '';

  str += `<${json.name} `;

  if (json.bindings._spread) {
    str += ` {...(${processBinding(
      json.bindings._spread as string,
      options,
    )})} `;
  }

  for (const key in json.properties) {
    const value = json.properties[key];
    str += ` ${key}="${(value as string).replace(/"/g, '&quot;')}" `;
  }

  for (const key in json.bindings) {
    const value = json.bindings[key] as string;
    if (key === '_spread') {
      continue;
    }
    if (key === 'css' && value.trim() === '{}') {
      continue;
    }

    const useBindingValue = processBinding(value, options);
    if (key.startsWith('on')) {
      str += ` ${key}={event => (${useBindingValue})} `;
    } else if (BINDING_MAPPERS[key]) {
      const mapper = BINDING_MAPPERS[key];
      if (typeof mapper === 'function') {
        const [newKey, newValue] = mapper(key, useBindingValue);
        str += ` ${newKey}={${newValue}} `;
      } else {
        str += ` ${BINDING_MAPPERS[key]}={${useBindingValue}} `;
      }
    } else {
      str += ` ${key}={${useBindingValue}} `;
    }
  }
  if (selfClosingTags.has(json.name)) {
    return str + ' />';
  }
  str += '>';
  if (json.children) {
    str += json.children.map((item) => blockToReact(item, options)).join('\n');
  }

  return str + `</${json.name}>`;
};

const getRefsString = (json: JSXLiteComponent, refs = getRefs(json)) => {
  let str = '';

  for (const ref of Array.from(refs)) {
    str += `\nconst ${ref} = useRef();`;
  }

  return str;
};

const processBinding = (str: string, options: ToReactOptions) => {
  if (options.stateType !== 'useState') {
    return str;
  }

  return stripStateAndPropsRefs(str, {
    includeState: true,
    includeProps: false,
  });
};

const getUseStateCode = (json: JSXLiteComponent, options: ToReactOptions) => {
  let str = '';

  const { state } = json;

  const valueMapper = (val: string) => processBinding(val, options);

  const keyValueDelimiter = '=';
  const lineItemDelimiter = '\n';

  for (const key in state) {
    const value = state[key];
    if (typeof value === 'string') {
      if (value.startsWith(functionLiteralPrefix)) {
        const functionValue = value.replace(functionLiteralPrefix, '');
        str += `const [${key}, set${capitalize(
          key,
        )}] ${keyValueDelimiter} useState(() => (${valueMapper(
          functionValue,
        )}))${lineItemDelimiter} `;
      } else if (value.startsWith(methodLiteralPrefix)) {
        const methodValue = value.replace(methodLiteralPrefix, '');
        const useValue = methodValue.replace(/^(get )?/, 'function ');
        str += `${valueMapper(useValue)} ${lineItemDelimiter}`;
      } else {
        str += `const [${key}, set${capitalize(
          key,
        )}] ${keyValueDelimiter} useState(() => (${valueMapper(
          json5.stringify(value),
        )}))${lineItemDelimiter} `;
      }
    } else {
      str += `const [${key}, set${capitalize(
        key,
      )}] ${keyValueDelimiter} useState(() => (${valueMapper(
        json5.stringify(value),
      )}))${lineItemDelimiter} `;
    }
  }

  return str;
};

const updateStateSetters = (json: JSXLiteComponent) => {
  traverse(json).forEach(function(item) {
    if (isJsxLiteNode(item)) {
      for (const key in item.bindings) {
        const value = item.bindings[key] as string;
        const newValue = updateStateSettersInCode(value);
        if (newValue !== value) {
          item.bindings[key] = newValue;
        }
      }
    }
  });
};

const updateStateSettersInCode = (value: string) => {
  return babelTransformExpression(value, {
    AssignmentExpression(
      path: babel.NodePath<babel.types.AssignmentExpression>,
    ) {
      const { node } = path;
      if (types.isMemberExpression(node.left)) {
        if (types.isIdentifier(node.left.object)) {
          // TODO: utillity to properly trace this reference to the beginning
          if (node.left.object.name === 'state') {
            // TODO: ultimately support other property access like strings
            const propertyName = (node.left.property as types.Identifier).name;
            path.replaceWith(
              types.callExpression(
                types.identifier(`set${capitalize(propertyName)}`),
                [node.right],
              ),
            );
          }
        }
      }
    },
  });
};

const getInitCode = (json: JSXLiteComponent): string => {
  if (!json.hooks.init) {
    return '';
  }
  return `
    const [firstRender, setFirstRender] = React.useState(true);
    if (firstRender) {
      setFirstRender(false);
      ${json.hooks.init}
    }
  `;
};

type ReactExports = 'useState' | 'useRef' | 'useCallback' | 'useEffect';

export const componentToReact = (
  componentJson: JSXLiteComponent,
  options: ToReactOptions = {},
) => {
  let json = fastClone(componentJson);
  if (options.plugins) {
    json = runPreJsonPlugins(json, options.plugins);
  }
  const componentHasStyles = hasStyles(json);
  if (options.stateType === 'useState') {
    gettersToFunctions(json);
    updateStateSetters(json);
  }

  const refs = getRefs(componentJson);
  const hasState = Boolean(Object.keys(json.state).length);
  mapRefs(json, (refName) => `${refName}.current`);

  const stylesType = options.stylesType || 'emotion';
  const stateType = options.stateType || 'mobx';

  const useStateCode =
    stateType === 'useState' && getUseStateCode(json, options);
  if (options.plugins) {
    json = runPostJsonPlugins(json, options.plugins);
  }

  const css =
    stylesType === 'styled-jsx' &&
    collectCss(json, { classProperty: 'className' });

  const styledComponentsCode =
    stylesType === 'styled-components' &&
    componentHasStyles &&
    collectStyledComponents(json);

  const reactLibImports: Set<ReactExports> = new Set();
  if (useStateCode && useStateCode.length > 4) {
    reactLibImports.add('useState');
  }
  if (refs.size) {
    reactLibImports.add('useRef');
  }

  let str = dedent`
  ${
    reactLibImports.size
      ? `import { ${Array.from(reactLibImports).join(', ')} } from 'react'`
      : ''
  }
  ${
    componentHasStyles && stylesType === 'emotion'
      ? `/** @jsx jsx */
    import { jsx } from '@emotion/react'`.trim()
      : ''
  }
    ${
      hasState && stateType === 'valtio'
        ? `import { useLocalProxy } from 'valtio/utils';`
        : ''
    }
    ${
      hasState && stateType === 'solid'
        ? `import { useMutable } from 'react-solid-state';`
        : ''
    }
    ${
      stateType === 'mobx' && hasState
        ? `import { useLocalObservable } from 'mobx-react-lite';`
        : ''
    }
    ${renderPreComponent(json)}
    ${styledComponentsCode ? styledComponentsCode : ''}

    export default function ${json.name}(props) {
      ${
        hasState
          ? stateType === 'mobx'
            ? `const state = useLocalObservable(() => (${getStateObjectString(
                json,
              )}))`
            : stateType === 'useState'
            ? useStateCode
            : stateType === 'builder'
            ? `const state = useBuilderState(${getStateObjectString(json)})`
            : stateType === 'solid'
            ? `const state = useMutable(${getStateObjectString(json)});`
            : `const state = useLocalProxy(${getStateObjectString(json)});`
          : ''
      }
      ${getRefsString(json)}
      ${getInitCode(json)}

      ${
        json.hooks.onMount
          ? `useEffect(() => {
            ${processBinding(
              updateStateSettersInCode(json.hooks.onMount!),
              options,
            )}
          }, [])`
          : ''
      }

      return (
        <>
        ${
          componentHasStyles && stylesType === 'styled-jsx'
            ? `<style jsx>{\`${css}\`}</style>`
            : ''
        }
        ${json.children.map((item) => blockToReact(item, options)).join('\n')}
        </>
      );
    }

  `;

  if (options.plugins) {
    str = runPreCodePlugins(str, options.plugins);
  }
  if (options.prettier !== false) {
    try {
      str = format(str, {
        parser: 'typescript',
        plugins: [
          require('prettier/parser-typescript'), // To support running in browsers
          require('prettier/parser-postcss'),
        ],
      })
        // Remove spaces between imports
        .replace(/;\n\nimport\s/g, ';\nimport ');
    } catch (err) {
      console.error(
        'Format error for file:',
        str,
        JSON.stringify(json, null, 2),
      );
      throw err;
    }
  }
  if (options.plugins) {
    str = runPostCodePlugins(str, options.plugins);
  }
  return str;
};
