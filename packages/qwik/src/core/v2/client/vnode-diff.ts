import { isQwikComponent, type Component, type OnRenderFn } from '../../component/component.public';
import { SERIALIZABLE_STATE } from '../../container/serializers';
import { assertDefined, assertFalse, assertTrue } from '../../error/assert';
import type { QRLInternal } from '../../qrl/qrl-class';
import { Fragment, isJSXNode } from '../../render/jsx/jsx-runtime';
import { Slot } from '../../render/jsx/slot.public';
import type { JSXNode } from '../../render/jsx/types/jsx-node';
import { isSignal } from '../../state/signal';
import { EMPTY_ARRAY } from '../../util/flyweight';
import { throwErrorAndStop } from '../../util/log';
import { ELEMENT_KEY, ELEMENT_PROPS, OnRenderProp } from '../../util/markers';
import { isPromise } from '../../util/promises';
import type { ValueOrPromise } from '../../util/types';
import { executeComponent2 } from '../shared/component-execution';
import type { QElement2 } from '../shared/types';
import type { SsrAttrs } from '../ssr/types';
import {
  ElementVNodeProps,
  type ClientContainer,
  type ElementVNode,
  type TextVNode,
  type VNode,
  type VirtualVNode,
} from './types';
import {
  mapArray_set,
  vnode_ensureElementInflated,
  vnode_getElementName,
  vnode_getFirstChild,
  vnode_getNextSibling,
  vnode_getNode,
  vnode_getProp,
  vnode_getText,
  vnode_getType,
  vnode_insertBefore,
  vnode_isElementVNode,
  vnode_isVirtualVNode,
  vnode_newElement,
  vnode_newText,
  vnode_newVirtual,
  vnode_remove,
  vnode_setAttr,
  vnode_setProp,
  vnode_setText,
  vnode_truncate,
} from './vnode';

export type VNodeJournalEntry = VNodeJournalOpCode | VNode | null | string;

export const enum VNodeJournalOpCode {
  ////////// Generic

  /// ENCODING
  Insert,
  Truncate,
  Remove,
  Move,
  ////////// TEXT
  TextSet,
  ////////// Element
  ElementInsert,
  Attributes,
  ////////// Fragment
  FragmentInsert,
}

export type ComponentQueue = Array<VNode>;

export const vnode_diff = (
  container: ClientContainer,
  jsxNode: JSXNode<any>,
  vStartNode: VNode
) => {
  const journal = container.$journal$;

  /**
   * Stack is used to keep track of the state of the traversal.
   *
   * We push current state into the stack before descending into the child, and we pop the state
   * when we are done with the child.
   */
  const stack: any[] = [];

  const asyncQueue: Array<VNode | ValueOrPromise<JSXNode>> = [];

  ////////////////////////////////
  //// Traverse state variables
  ////////////////////////////////
  let vParent: VNode = null!;
  /// Current node we compare against. (Think of it as a cursor.)
  /// (Node can be null, if we are at the end of the list.)
  let vCurrent: VNode | null = null;
  /// When we insert new node we start it here so that we can descend into it.
  /// NOTE: it can't be stored in `vCurrent` because `vNewCurrent` is in journal
  /// and is not connected to the tree.
  let vNewNode: VNode | null = null;
  /// When elements have keys they can be consumed out of order and therefore we can't use nextSibling.
  /// In such a case this array will contain the elements after the current location.
  /// The array even indices will contains keys and odd indices the vNode.
  let vSiblings: Array<string | null | VNode> | null = null;
  let vSiblingsIdx = -1;
  /// Current set of JSX children.
  let jsxChildren: any[] = null!;
  // Current JSX child.
  let jsxValue: any = null;
  let jsxIdx = 0;
  let jsxCount = 0;
  ////////////////////////////////

  diff(jsxNode, vStartNode);
  return drainAsyncQueue();

  //////////////////////////////////////////////
  //////////////////////////////////////////////
  //////////////////////////////////////////////

  function diff(jsxNode: JSXNode<any>, vStartNode: VNode) {
    vParent = vStartNode;
    vNewNode = null;
    vCurrent = vnode_getFirstChild(vStartNode);
    stackPush(jsxNode, true);
    while (stack.length) {
      while (jsxIdx < jsxCount) {
        assertFalse(vParent === vCurrent, "Parent and current can't be the same");
        if (typeof jsxValue === 'string') {
          expectText(jsxValue);
        } else if (typeof jsxValue === 'number') {
          expectText(String(jsxValue));
        } else if (typeof jsxValue === 'object') {
          if (Array.isArray(jsxValue)) {
            descend(jsxValue, false);
            continue; // we just descended, skip advance()
          } else if (isSignal(jsxValue)) {
            throw new Error('implement');
          } else if (isJSXNode(jsxValue)) {
            const type = jsxValue.type;
            if (typeof type === 'string') {
              expectNoMoreTextNodes();
              expectElement(jsxValue, type);
              descend(jsxValue.children, true);
              continue; // we just descended, skip advance()
            } else if (type === Fragment) {
              expectNoMoreTextNodes();
              expectVirtual();
              descend(jsxValue.children, true);
              continue; // we just descended, skip advance()
            } else if (type === Slot) {
              expectSlot();
            } else if (isQwikComponent(type)) {
              expectNoMoreTextNodes();
              expectVirtual();
              expectComponent(type);
            } else {
              throwErrorAndStop(`Unsupported type: ${type}`);
            }
          } else {
            throwErrorAndStop(`Unsupported value: ${jsxValue}`);
          }
        } else {
          expectText('');
        }
        advance();
      }
      expectNoMore();
      ascend();
    }
  }

  function advance() {
    jsxIdx++;
    if (jsxIdx < jsxCount) {
      jsxValue = jsxChildren[jsxIdx];
    } else if (stack[stack.length - 1] === false) {
      // this was special `descendVNode === false` so pop and try again
      return ascend();
    }
    if (vNewNode !== null) {
      // We have a new Node.
      // This means that the `vCurrent` was deemed not useful and we inserted in front of it.
      // This means that the next node we should look at is the `vCurrent` so just clear the
      // vNewNode  and try again.
      vNewNode = null;
    } else if (vSiblings !== null) {
      // We came across a key, and we moved nodes around. This means we can no longer use
      // `vnode_getNextSibling` to look at next node and instead we have to go by `vSiblings`.
      vSiblingsIdx += 2; // advance;
      vCurrent = vSiblingsIdx < vSiblings.length ? (vSiblings[vSiblingsIdx + 1] as any) : null;
    } else {
      // If we don't have a `vNewNode`, than that means we just reconciled the current node.
      // So advance it.
      vCurrent = vCurrent ? vnode_getNextSibling(vCurrent) : null;
    }
  }

  /**
   * @param children
   * @param descendVNode - If true we are descending into vNode; This is set to false if we come
   *   across an array in jsx, and we need to descend into the array without actually descending
   *   into the vNode.
   *
   *   Example:
   *
   *   ```
   *   <>
   *   before
   *   {[1,2].map((i) => <span>{i}</span>)}
   *   after
   *   </>
   * ```
   *
   *   In the above example all nodes are on same level so we don't `descendVNode` even thought there
   *   is an array produced by the `map` function.
   */
  function descend(children: any, descendVNode: boolean) {
    stackPush(children, descendVNode);
    if (descendVNode) {
      assertDefined(vCurrent || vNewNode, 'Expecting vCurrent to be defined.');
      vSiblings = null;
      vSiblingsIdx = -1;
      vParent = vNewNode || vCurrent!;
      vCurrent = vnode_getFirstChild(vParent);
      vNewNode = null;
    }
  }

  function ascend() {
    const descendVNode = stack.pop(); // boolean: descendVNode
    if (descendVNode) {
      vSiblingsIdx = stack.pop();
      vSiblings = stack.pop();
      vNewNode = stack.pop();
      vCurrent = stack.pop();
      vParent = stack.pop();
    }
    jsxValue = stack.pop();
    jsxCount = stack.pop();
    jsxIdx = stack.pop();
    jsxChildren = stack.pop();
    advance();
  }

  function stackPush(children: any, descendVNode: boolean) {
    stack.push(jsxChildren, jsxIdx, jsxCount, jsxValue);
    if (descendVNode) {
      stack.push(vParent, vCurrent, vNewNode, vSiblings, vSiblingsIdx);
    }
    stack.push(descendVNode);
    if (Array.isArray(children)) {
      jsxIdx = 0;
      jsxCount = children.length;
      jsxChildren = children;
      jsxValue = jsxCount > 0 ? children[0] : null;
    } else if (children === undefined) {
      // no children
      jsxIdx = 0;
      jsxValue = null;
      jsxChildren = null!;
      jsxCount = 0;
    } else {
      jsxIdx = 0;
      jsxValue = children;
      jsxChildren = null!;
      jsxCount = 1;
    }
  }

  function getInsertBefore() {
    if (vNewNode) {
      return vCurrent;
    } else if (vSiblings !== null) {
      const nextIdx = vSiblingsIdx + 3; // 2 plus 1 for node offset
      return nextIdx < vSiblings.length ? vSiblings[nextIdx] : null;
    } else {
      return vCurrent && vnode_getNextSibling(vCurrent);
    }
  }

  /////////////////////////////////////////////////////////////////////////////
  /////////////////////////////////////////////////////////////////////////////
  /////////////////////////////////////////////////////////////////////////////

  function drainAsyncQueue(): ValueOrPromise<void> {
    while (asyncQueue.length) {
      const jsxNode = asyncQueue.shift() as ValueOrPromise<JSXNode>;
      const vHostNode = asyncQueue.shift() as VNode;
      if (isPromise(jsxNode)) {
        return jsxNode.then((jsxNode) => {
          diff(jsxNode, vHostNode);
          return drainAsyncQueue();
        });
      } else {
        diff(jsxNode, vHostNode);
      }
    }
  }

  function expectNoMore() {
    assertFalse(vParent === vCurrent, "Parent and current can't be the same");
    if (vCurrent !== null) {
      journal.push(VNodeJournalOpCode.Truncate, vParent, vCurrent);
    }
  }

  function expectNoMoreTextNodes() {
    while (vCurrent !== null && vnode_getType(vCurrent) === 3 /* Text */) {
      journal.push(VNodeJournalOpCode.Remove, vParent, vCurrent);
      vCurrent = vnode_getNextSibling(vCurrent);
    }
  }

  function expectElement(jsx: JSXNode<any>, tag: string) {
    const isSameTagName =
      vCurrent && vnode_isElementVNode(vCurrent) && tag === vnode_getElementName(vCurrent);
    let jsxKey: any;
    if (
      isSameTagName &&
      (jsxKey = jsx.key) == vnode_getProp(vCurrent as ElementVNode, ELEMENT_KEY, null)
    ) {
      // All is good.
    } else if (jsxKey !== null) {
      // So we have a key and it does not match the current node.
      // We need to do a forward search to find it.
      // The complication is that once we start taking nodes out of order we can't use `vnode_getNextSibling`
      vNewNode = retrieveChildWithKey(jsxKey);
      if (vNewNode === null) {
        // No existing node with key exists, just create a new one.
        journal.push(
          VNodeJournalOpCode.Insert,
          vParent,
          (vNewNode = vnode_newElement(vParent, container.document.createElement(tag), tag)),
          vCurrent
        );
      } else {
        // Existing keyed node
        journal.push(VNodeJournalOpCode.Move, vParent, vNewNode, vCurrent);
      }
    } else {
      journal.push(
        VNodeJournalOpCode.Insert,
        vParent,
        (vNewNode = vnode_newElement(vParent, container.document.createElement(tag), tag)),
        vCurrent
      );
    }
    // reconcile attributes
    let jsxAttrs = (jsx as any as { attrs: SsrAttrs }).attrs;
    if (jsxAttrs === EMPTY_ARRAY) {
      const props = jsx.props;
      for (const key in props) {
        if (jsxAttrs === EMPTY_ARRAY) {
          jsxAttrs = (jsx as any as { attrs: SsrAttrs }).attrs = [];
        }
        mapArray_set(jsxAttrs, key, props[key], 0);
      }
      const jsxKey = jsx.key;
      if (jsxKey !== null) {
        if (jsxAttrs === EMPTY_ARRAY) {
          jsxAttrs = (jsx as any as { attrs: SsrAttrs }).attrs = [ELEMENT_KEY, jsxKey];
        } else {
          mapArray_set(jsxAttrs, ELEMENT_KEY, jsxKey, 0);
        }
      }
    }
    setBulkProps((vNewNode || vCurrent) as ElementVNode, jsxAttrs);
  }

  function setBulkProps(vnode: ElementVNode, srcAttrs: SsrAttrs) {
    vnode_ensureElementInflated(vnode);
    const dstAttrs = vnode as SsrAttrs;
    let hasDiffs = false;
    let srcIdx = 0;
    const srcLength = srcAttrs.length;
    let dstIdx = ElementVNodeProps.PROPS_OFFSET;
    const dstLength = dstAttrs.length;
    let srcKey: string | null = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
    let dstKey: string | null = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
    let patchEventDispatch = false;
    const record = (key: string, value: any) => {
      if (!hasDiffs) {
        journal.push(VNodeJournalOpCode.Attributes, vnode);
        hasDiffs = true;
      }
      journal.push(key, value);
    };
    while (srcKey !== null || dstKey !== null) {
      if (srcKey == null) {
        // Source has more keys, so we need to remove them from destination
        if (dstKey?.startsWith('on:')) {
          patchEventDispatch = true;
        } else {
          record(dstKey!, null);
        }
        dstIdx++; // skip the destination value, we don't care about it.
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      } else if (dstKey == null) {
        // Destination has more keys, so we need to insert them from source.
        const isEvent = srcKey.startsWith('on') && srcKey.endsWith('$');
        if (isEvent) {
          // Special handling for events
          patchEventDispatch = true;
        }
        record(srcKey!, srcAttrs[srcIdx++]);
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
      } else if (srcKey == dstKey) {
        const srcValue = srcAttrs[srcIdx++];
        const dstValue = dstAttrs[dstIdx++];
        if (srcValue !== dstValue) {
          record(dstKey, srcValue);
        }
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      } else if (srcKey < dstKey) {
        // Destination is missing the key, so we need to insert it.
        const srcValue = srcAttrs[srcIdx++];
        record(srcKey, srcValue);
        // advance srcValue
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
      } else {
        // Source is missing the key, so we need to remove it from destination.
        record(dstKey, null);
        dstIdx++; // skip the destination value, we don't care about it.
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      }
    }
    if (patchEventDispatch) {
      const element = vnode_getNode(vnode) as QElement2;
      if (!element.qDispatchEvent) {
        element.qDispatchEvent = (event: Event) => {
          const eventName = event.type;
          const eventProp = 'on' + eventName.charAt(0).toUpperCase() + eventName.substring(1) + '$';
          const qrls = vnode_getProp(vnode, eventProp, null);
          let returnValue = false;
          qrls &&
            (Array.isArray(qrls) ? qrls : [qrls]).forEach((qrl) => {
              const value = qrl(event);
              returnValue = returnValue || value === true;
            });
          return returnValue;
        };
      }
    }
  }

  function retrieveChildWithKey(key: string): ElementVNode | VirtualVNode | null {
    let vNodeWithKey: ElementVNode | VirtualVNode | null = null;
    if (vSiblingsIdx === -1) {
      // it is not materialized; so materialize it.
      vSiblings = [];
      vSiblingsIdx = 0;
      let vNode = vCurrent;
      while (vNode) {
        const vKey = vnode_getProp<string>(vNode, ELEMENT_KEY, null);
        if (vNodeWithKey === null && vKey == key) {
          vNodeWithKey = vNode as ElementVNode | VirtualVNode;
        } else {
          // we only add the elements which we did not find yet.
          vSiblings.push(vKey, vNode);
        }
        vNode = vnode_getNextSibling(vNode);
      }
    } else {
      for (let idx = vSiblingsIdx; idx < vSiblings!.length; idx += 2) {
        const vKey = vSiblings![idx];
        if (vKey == key) {
          vNodeWithKey = vSiblings![idx + 1] as any;
          // remove the node from the siblings array
          vSiblings?.splice(idx, 2);
          break;
        }
      }
    }
    return vNodeWithKey;
  }

  function expectVirtual() {
    if (vCurrent && vnode_isVirtualVNode(vCurrent)) {
      // All is good.
    } else {
      journal.push(
        VNodeJournalOpCode.Insert,
        vParent,
        (vNewNode = vnode_newVirtual(vParent)),
        vCurrent && getInsertBefore(vCurrent)
      );
    }
  }

  function expectSlot() {
    throw new Error('IMPLEMENT');
  }

  function expectComponent(component: Component<any>) {
    const [componentQRL] = (component as any)[SERIALIZABLE_STATE] as [QRLInternal<OnRenderFn<any>>];
    const host = (vCurrent || vNewNode) as VirtualVNode;
    const vNodeQrl = vnode_getProp<QRLInternal>(host, OnRenderProp, container.getObjectById);
    let shouldRender = false;
    if (componentQRL.$hash$ !== vNodeQrl?.$hash$) {
      vnode_setProp(host, OnRenderProp, componentQRL);
      shouldRender = true;
    }
    const vNodeProps = vnode_getProp<any>(host, ELEMENT_PROPS, container.getObjectById);
    const jsxPros = jsxValue.props;
    shouldRender = shouldRender || !shallowEqual(jsxPros, vNodeProps);
    if (shouldRender) {
      const jsx = executeComponent2(container, host, componentQRL, jsxPros);
      asyncQueue.push(jsx, host);
    }
  }

  function expectText(text: string) {
    if (vCurrent !== null) {
      const type = vnode_getType(vCurrent);
      if (type === 3 /* Text */) {
        if (text !== vnode_getText(vCurrent as TextVNode)) {
          journal.push(VNodeJournalOpCode.TextSet, vCurrent, text);
          return;
        }
        return;
      }
    }
    journal.push(
      VNodeJournalOpCode.Insert,
      vParent,
      vnode_newText(vParent, container.document.createTextNode(text), text),
      vCurrent
    );
  }
};

export const vnode_applyJournal = (journal: VNodeJournalEntry[]) => {
  let idx = 0;
  while (idx < journal.length) {
    const opCode = journal[idx++] as number;
    assertTrue(typeof opCode === 'number', 'Expecting opCode to be a number.');
    switch (opCode) {
      case VNodeJournalOpCode.TextSet:
        vnode_setText(journal[idx++] as TextVNode, journal[idx++] as string);
        break;
      case VNodeJournalOpCode.Insert:
        vnode_insertBefore(
          journal[idx++] as ElementVNode | VirtualVNode,
          journal[idx++] as VNode,
          journal[idx++] as VNode
        );
        break;
      case VNodeJournalOpCode.Truncate:
        vnode_truncate(journal[idx++] as ElementVNode | VirtualVNode, journal[idx++] as VNode);
        break;
      case VNodeJournalOpCode.Remove:
        vnode_remove(journal[idx++] as ElementVNode | VirtualVNode, journal[idx++] as VNode, true);
        break;
      case VNodeJournalOpCode.Move:
        const vParent = journal[idx++] as ElementVNode | VirtualVNode;
        const vNodeToMove = journal[idx++] as VNode;
        const vNodeMoveInFrontOf = journal[idx++] as VNode | null;
        vnode_remove(vParent, vNodeToMove, false);
        vnode_insertBefore(vParent, vNodeToMove, vNodeMoveInFrontOf);
        break;
      case VNodeJournalOpCode.Attributes:
        const vnode = journal[idx++] as ElementVNode;
        let key: string | null = null;
        while (typeof (key = journal[idx] as string | null) === 'string') {
          idx++;
          const value = journal[idx++] as string | null;
          if (key.startsWith('on') && key.endsWith('$')) {
            // special handling for events.
            vnode_setProp(vnode, key, value);
          } else {
            vnode_setAttr(vnode, key, value);
          }
        }
        break;
      default:
        throwErrorAndStop(`Unsupported opCode: ${opCode}`);
    }
  }
  journal.length = 0;
};

function shallowEqual(src: Record<string, any>, dst: Record<string, any>): boolean {
  let srcKeys = Object.keys(src);
  let dstKeys = Object.keys(dst);
  if (srcKeys.length !== dstKeys.length) {
    return false;
  }
  srcKeys = srcKeys.sort();
  dstKeys = dstKeys.sort();
  for (let idx = 0; idx < srcKeys.length; idx++) {
    const srcKey = srcKeys[idx];
    const dstKey = dstKeys[idx];
    if (srcKey !== dstKey || src[srcKey] !== dst[dstKey]) {
      return false;
    }
  }
  return true;
}
function vnode_getChildWithIdx(jsxKey: any) {
  throw new Error('Function not implemented.');
}
