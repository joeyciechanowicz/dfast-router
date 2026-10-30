export interface MedleyRouteMatch<TStore> {
  store: TStore;
  params: Record<string, string>;
}

export interface MedleyRouterOptions<TStore> {
  storeFactory?: () => TStore;
}

interface ParametricNode<TStore> {
  paramName: string;
  store: TStore | null;
  staticChild: Node<TStore> | null;
}

interface Node<TStore> {
  pathPart: string;
  store: TStore | null;
  staticChildren: Map<number, Node<TStore>> | null;
  parametricChild: ParametricNode<TStore> | null;
  wildcardStore: TStore | null;
}

interface DebugTree {
  [key: string]: DebugTree | null;
}

function createNode<TStore>(
  pathPart: string,
  staticChildren?: Array<Node<TStore>>,
): Node<TStore> {
  return {
    pathPart,
    store: null,
    staticChildren:
      staticChildren === undefined
        ? null
        : new Map(
            staticChildren.map((child) => [child.pathPart.charCodeAt(0), child]),
          ),
    parametricChild: null,
    wildcardStore: null,
  };
}

function cloneNode<TStore>(node: Node<TStore>, newPathPart: string): Node<TStore> {
  return {
    pathPart: newPathPart,
    store: node.store,
    staticChildren: node.staticChildren,
    parametricChild: node.parametricChild,
    wildcardStore: node.wildcardStore,
  };
}

function createParametricNode<TStore>(paramName: string): ParametricNode<TStore> {
  return {
    paramName,
    store: null,
    staticChild: null,
  };
}

function defaultStoreFactory(): Record<string, never> {
  return Object.create(null) as Record<string, never>;
}

export class MedleyRouter<TStore = Record<string, never>> {
  private _root: Node<TStore>;
  private readonly _storeFactory: () => TStore;

  constructor(options: MedleyRouterOptions<TStore> = {}) {
    const { storeFactory } = options;

    if (storeFactory === undefined) {
      this._storeFactory = defaultStoreFactory as unknown as () => TStore;
    } else if (typeof storeFactory === "function") {
      this._storeFactory = () => {
        const store = storeFactory();
        if (store === null) {
          throw new Error(
            "Custom storeFactory returned `null`, which is not allowed",
          );
        }
        return store;
      };
    } else {
      throw new TypeError("`storeFactory` must be a function");
    }

    this._root = createNode<TStore>("/");
  }

  register(path: string): TStore {
    if (typeof path !== "string") {
      throw new TypeError("Route path must be a string");
    }
    if (path === "" || path[0] !== "/") {
      throw new Error(
        `Invalid route: ${path}\nRoute path must begin with a "/"`,
      );
    }

    const endsWithWildcard = path.endsWith("*");
    let routePath = path;

    if (endsWithWildcard) {
      routePath = routePath.slice(0, -1);
    }

    const staticParts = routePath.split(/:.+?(?=\/|$)/);
    const paramParts = routePath.match(/:.+?(?=\/|$)/g) ?? [];

    if (staticParts[staticParts.length - 1] === "") {
      staticParts.pop();
    }

    let node = this._root;
    let paramPartsIndex = 0;

    for (let i = 0; i < staticParts.length; ++i) {
      let pathPart = staticParts[i];

      if (i > 0) {
        const paramName = paramParts[paramPartsIndex]!.slice(1);
        paramPartsIndex += 1;

        if (node.parametricChild === null) {
          node.parametricChild = createParametricNode(paramName);
        } else if (node.parametricChild.paramName !== paramName) {
          throw new Error(
            `Cannot create route "${routePath}" with parameter "${paramName}" ` +
              "because a route already exists with a different parameter name " +
              `("${node.parametricChild.paramName}") in the same location`,
          );
        }

        const { parametricChild } = node;
        if (parametricChild.staticChild === null) {
          node = parametricChild.staticChild = createNode<TStore>(pathPart);
          continue;
        }

        node = parametricChild.staticChild;
      }

      for (let j = 0; ; ) {
        if (j === pathPart.length) {
          if (j < node.pathPart.length) {
            const childNode = cloneNode(node, node.pathPart.slice(j));
            Object.assign(node, createNode<TStore>(pathPart, [childNode]));
          }
          break;
        }

        if (j === node.pathPart.length) {
          if (node.staticChildren === null) {
            node.staticChildren = new Map();
          } else {
            const childCode = pathPart.charCodeAt(j);
            if (node.staticChildren.has(childCode)) {
              node = node.staticChildren.get(childCode)!;
              pathPart = pathPart.slice(j);
              j = 0;
              continue;
            }
          }

          const childNode = createNode<TStore>(pathPart.slice(j));
          node.staticChildren.set(pathPart.charCodeAt(j), childNode);
          node = childNode;
          break;
        }

        if (pathPart[j] !== node.pathPart[j]) {
          const existingChild = cloneNode(node, node.pathPart.slice(j));
          const newChild = createNode<TStore>(pathPart.slice(j));

          Object.assign(
            node,
            createNode<TStore>(node.pathPart.slice(0, j), [existingChild, newChild]),
          );

          node = newChild;
          break;
        }

        ++j;
      }
    }

    if (paramPartsIndex < paramParts.length) {
      const paramName = paramParts[paramPartsIndex]!.slice(1);

      if (node.parametricChild === null) {
        node.parametricChild = createParametricNode(paramName);
      } else if (node.parametricChild.paramName !== paramName) {
        throw new Error(
          `Cannot create route "${routePath}" with parameter "${paramName}" ` +
            "because a route already exists with a different parameter name " +
            `("${node.parametricChild.paramName}") in the same location`,
        );
      }

      if (node.parametricChild.store === null) {
        node.parametricChild.store = this._storeFactory();
      }

      return node.parametricChild.store;
    }

    if (endsWithWildcard) {
      if (node.wildcardStore === null) {
        node.wildcardStore = this._storeFactory();
      }
      return node.wildcardStore;
    }

    if (node.store === null) {
      node.store = this._storeFactory();
    }
    return node.store;
  }

  find(url: string): MedleyRouteMatch<TStore> | null {
    if (url === "" || url[0] !== "/") {
      return null;
    }

    const queryIndex = url.indexOf("?");
    const urlLength = queryIndex >= 0 ? queryIndex : url.length;
    return matchRoute(url, urlLength, this._root, 0);
  }

  debugTree(): string {
    const treeify = require("object-treeify") as (value: unknown) => string;
    return treeify(debugNode(this._root)).replace(/^.{3}/gm, "");
  }
}

export function createMedleyRouter<TStore = Record<string, never>>(
  options?: MedleyRouterOptions<TStore>,
): MedleyRouter<TStore> {
  return new MedleyRouter(options);
}

function matchRoute<TStore>(
  url: string,
  urlLength: number,
  node: Node<TStore>,
  startIndex: number,
): MedleyRouteMatch<TStore> | null {
  const { pathPart } = node;
  const pathPartLen = pathPart.length;
  const pathPartEndIndex = startIndex + pathPartLen;

  if (pathPartLen > 1) {
    if (pathPartEndIndex > urlLength) {
      return null;
    }

    if (pathPartLen < 15) {
      for (let i = 1, j = startIndex + 1; i < pathPartLen; ++i, ++j) {
        if (pathPart[i] !== url[j]) {
          return null;
        }
      }
    } else if (url.slice(startIndex, pathPartEndIndex) !== pathPart) {
      return null;
    }
  }

  startIndex = pathPartEndIndex;

  if (startIndex === urlLength) {
    if (node.store !== null) {
      return {
        store: node.store,
        params: {},
      };
    }

    if (node.wildcardStore !== null) {
      return {
        store: node.wildcardStore,
        params: { "*": "" },
      };
    }

    return null;
  }

  if (node.staticChildren !== null) {
    const staticChild = node.staticChildren.get(url.charCodeAt(startIndex));
    if (staticChild !== undefined) {
      const route = matchRoute(url, urlLength, staticChild, startIndex);
      if (route !== null) {
        return route;
      }
    }
  }

  if (node.parametricChild !== null) {
    const parametricNode = node.parametricChild;
    const slashIndex = url.indexOf("/", startIndex);

    if (slashIndex !== startIndex) {
      if (slashIndex === -1 || slashIndex >= urlLength) {
        if (parametricNode.store !== null) {
          const params: Record<string, string> = {};
          params[parametricNode.paramName] = url.slice(startIndex, urlLength);
          return {
            store: parametricNode.store,
            params,
          };
        }
      } else if (parametricNode.staticChild !== null) {
        const route = matchRoute(
          url,
          urlLength,
          parametricNode.staticChild,
          slashIndex,
        );

        if (route !== null) {
          route.params[parametricNode.paramName] = url.slice(
            startIndex,
            slashIndex,
          );
          return route;
        }
      }
    }
  }

  if (node.wildcardStore !== null) {
    return {
      store: node.wildcardStore,
      params: {
        "*": url.slice(startIndex, urlLength),
      },
    };
  }

  return null;
}

function debugNode<TStore>(node: Node<TStore>): DebugTree {
  if (node.store === null && node.staticChildren === null) {
    if (node.parametricChild === null) {
      return { [node.pathPart + "* (s)"]: null };
    }

    if (node.wildcardStore === null) {
      if (node.parametricChild.store === null) {
        const staticChild = node.parametricChild.staticChild;
        return {
          [node.pathPart + ":" + node.parametricChild.paramName]:
            staticChild === null ? null : debugNode(staticChild),
        };
      }

      if (node.parametricChild.staticChild === null) {
        return {
          [node.pathPart + ":" + node.parametricChild.paramName + " (s)"]: null,
        };
      }
    }
  }

  const childRoutes: DebugTree = {};

  if (node.staticChildren !== null) {
    for (const childNode of node.staticChildren.values()) {
      Object.assign(childRoutes, debugNode(childNode));
    }
  }

  if (node.parametricChild !== null) {
    const { parametricChild } = node;
    const label =
      ":" + parametricChild.paramName + debugStore(parametricChild.store);

    childRoutes[label] =
      parametricChild.staticChild === null
        ? null
        : debugNode(parametricChild.staticChild);
  }

  if (node.wildcardStore !== null) {
    childRoutes["* (s)"] = null;
  }

  return {
    [node.pathPart + debugStore(node.store)]: childRoutes,
  };
}

function debugStore<TStore>(store: TStore | null): string {
  return store === null ? "" : " (s)";
}
