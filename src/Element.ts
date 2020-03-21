import Transformable from './core/Transformable';
import { AnimationEasing } from './animation/easing';
import Animator from './animation/Animator';
import { ZRenderType } from './zrender';
import { VectorArray } from './core/vector';
import { Dictionary, ElementEventName, ZRRawEvent, BuiltinTextPosition, AllPropTypes } from './core/types';
import Path from './graphic/Path';
import BoundingRect from './core/BoundingRect';
import Eventful, {EventQuery, EventCallback} from './core/Eventful';
import RichText from './graphic/RichText';
import { calculateTextPosition, TextPositionCalculationResult } from './contain/text';
import Storage from './Storage';
import {
    guid,
    isObject,
    keys,
    extend,
    indexOf,
    logError,
    isString,
    mixin,
    isFunction,
    isArrayLike
} from './core/util';

interface TextLayout {
    /**
     * Position relative to the element bounding rect
     * @default 'inside'
     */
    position?: BuiltinTextPosition | number[] | string[]

    /**
     * Distance to the rect
     * @default 5
     */
    distance?: number

    /**
     * If use local user space. Which will apply host's transform
     * @default false
     */
    local?: boolean

    // TODO applyClip
}

export interface ElementEvent {
    type: ElementEventName,
    event: ZRRawEvent,
    // target can only be an element that is not silent.
    target: Element,
    // topTarget can be a silent element.
    topTarget: Element,
    cancelBubble: boolean,
    offsetX: number,
    offsetY: number,
    gestureEvent: string,
    pinchX: number,
    pinchY: number,
    pinchScale: number,
    wheelDelta: number,
    zrByTouch: boolean,
    which: number,
    stop: (this: ElementEvent) => void
}

export type ElementEventCallback<Ctx, Impl> = (
    this: CbThis<Ctx, Impl>, e: ElementEvent
) => boolean | void
type CbThis<Ctx, Impl> = unknown extends Ctx ? Impl : Ctx;

interface ElementEventHandlerProps {
    // Events
    onclick: ElementEventCallback<unknown, unknown>
    ondblclick: ElementEventCallback<unknown, unknown>
    onmouseover: ElementEventCallback<unknown, unknown>
    onmouseout: ElementEventCallback<unknown, unknown>
    onmousemove: ElementEventCallback<unknown, unknown>
    onmousewheel: ElementEventCallback<unknown, unknown>
    onmousedown: ElementEventCallback<unknown, unknown>
    onmouseup: ElementEventCallback<unknown, unknown>
    oncontextmenu: ElementEventCallback<unknown, unknown>

    ondrag: ElementEventCallback<unknown, unknown>
    ondragstart: ElementEventCallback<unknown, unknown>
    ondragend: ElementEventCallback<unknown, unknown>
    ondragenter: ElementEventCallback<unknown, unknown>
    ondragleave: ElementEventCallback<unknown, unknown>
    ondragover: ElementEventCallback<unknown, unknown>
    ondrop: ElementEventCallback<unknown, unknown>

}

export interface ElementProps extends Partial<ElementEventHandlerProps> {
    name?: string
    ignore?: boolean
    isGroup?: boolean
    draggable?: boolean

    silent?: boolean
    // From transform
    position?: VectorArray
    rotation?: number
    scale?: VectorArray
    origin?: VectorArray
    globalScaleRatio?: number

    textLayout?: TextLayout
    textContent?: RichText

    clipPath?: Path
    drift?: Element['drift']

    // For echarts animation.
    anid?: string

    extra?: Dictionary<any>
}

type AnimationCallback = () => {}

let tmpTextPosCalcRes = {} as TextPositionCalculationResult;
let tmpBoundingRect = new BoundingRect();

interface Element<Props extends ElementProps = ElementProps> extends Transformable, Eventful, ElementEventHandlerProps {
    // Provide more typed event callback params for mouse events.
    on<Ctx>(event: ElementEventName, handler: ElementEventCallback<Ctx, this>, context?: Ctx): this
    on<Ctx>(event: string, handler: EventCallback<Ctx, this>, context?: Ctx): this

    on<Ctx>(event: ElementEventName, query: EventQuery, handler: ElementEventCallback<Ctx, this>, context?: Ctx): this
    on<Ctx>(event: string, query: EventQuery, handler: EventCallback<Ctx, this>, context?: Ctx): this
}

class Element<Props extends ElementProps = ElementProps> {

    id: number = guid()
    /**
     * Element type
     */
    type: string

    /**
     * Element name
     */
    name: string

    /**
     * If ignore drawing and events of the element object
     */
    ignore: boolean

    /**
     * Whether to respond to mouse events.
     */
    silent: boolean

    /**
     * 是否是 Group
     */
    isGroup: boolean

    /**
     * Whether it can be dragged.
     */
    draggable: boolean | string

    /**
     * Whether is it dragging.
     */
    dragging: boolean

    parent: Element

    animators: Animator<any>[] = [];

    /**
     * Extra object to store any info not related to the Element
     */
    extra: Dictionary<any>

    /**
     * ZRender instance will be assigned when element is associated with zrender
     */
    __zr: ZRenderType

    /**
     * Dirty flag. From which painter will determine if this displayable object needs brush.
     */
    __dirty: boolean

    __storage: Storage
    /**
     * path to clip the elements and its children, if it is a group.
     * @see http://www.w3.org/TR/2dcontext/#clipping-region
     */
    private _clipPath: Path

    /**
     * Attached text element.
     * `position`, `style.textAlign`, `style.textVerticalAlign`
     * of element will be ignored if textContent.position is set
     */
    private _textContent: RichText

    /**
     * Layout of textContent
     */
    textLayout: TextLayout

    // FOR ECHARTS
    /**
     * Id for mapping animation
     */
    anid: string

    constructor(props?: Props) {
        // Transformable needs position, rotation, scale
        Transformable.call(this);
        Eventful.call(this);

        this._init(props);
    }

    protected _init(props?: Props) {
        // Init default properties
        this.attr(props);
    }

    /**
     * Drift element
     * @param {number} dx dx on the global space
     * @param {number} dy dy on the global space
     */
    drift(dx: number, dy: number, e?: ElementEvent) {
        switch (this.draggable) {
            case 'horizontal':
                dy = 0;
                break;
            case 'vertical':
                dx = 0;
                break;
        }

        let m = this.transform;
        if (!m) {
            m = this.transform = [1, 0, 0, 1, 0, 0];
        }
        m[4] += dx;
        m[5] += dy;

        this.decomposeTransform();
        this.dirty();
    }

    /**
     * Hook before update
     */
    beforeUpdate() {}
    /**
     * Hook after update
     */
    afterUpdate() {}
    /**
     * Update each frame
     */
    update() {
        this.updateTransform();

        // Update textContent
        const textEl = this._textContent;
        if (textEl) {
            if (!this.textLayout) {
                this.textLayout = {};
            }
            const textLayout = this.textLayout;
            const isLocal = textLayout.local;
            tmpBoundingRect.copy(this.getBoundingRect());
            if (!isLocal) {
                tmpBoundingRect.applyTransform(this.transform);
            }
            else {
                // TODO parent is always be group for developers. But can be displayble inside.
                textEl.parent = this as unknown as Element;
            }
            calculateTextPosition(tmpTextPosCalcRes, textLayout, tmpBoundingRect);
            // TODO Not modify el.position?
            textEl.position[0] = tmpTextPosCalcRes.x;
            textEl.position[1] = tmpTextPosCalcRes.y;
            if (tmpTextPosCalcRes.textAlign) {
                textEl.style.textAlign = tmpTextPosCalcRes.textAlign;
            }
            if (tmpTextPosCalcRes.verticalAlign) {
                textEl.style.verticalAlign = tmpTextPosCalcRes.verticalAlign;
            }
            // Mark textEl to update transform.
            textEl.dirty();
        }
    }

    traverse<Context>(
        cb: (this: Context, el: Element<Props>) => void,
        context?: Context
    ) {}

    protected attrKV(key: string, value: unknown) {
        if (key === 'position' || key === 'scale' || key === 'origin') {
            // Copy the array
            if (value) {
                let target = this[key];
                if (!target) {
                    target = this[key] = [];
                }
                target[0] = (value as VectorArray)[0];
                target[1] = (value as VectorArray)[1];
            }
        }
        else if (key === 'textLayout') {
            this.setTextLayout(value as TextLayout);
        }
        else if (key === 'textContent') {
            this.setTextContent(value as RichText);
        }
        else if (key === 'clipPath') {
            this.setClipPath(value as Path);
        }
        else {
            (this as any)[key] = value;
        }
    }

    /**
     * Hide the element
     */
    hide() {
        this.ignore = true;
        this.__zr && this.__zr.refresh();
    }

    /**
     * Show the element
     */
    show() {
        this.ignore = false;
        this.__zr && this.__zr.refresh();
    }

    attr(keyOrObj: Props): this
    attr(keyOrObj: keyof Props, value: AllPropTypes<Props>): this
    /**
     * @param {string|Object} key
     * @param {*} value
     */
    attr(keyOrObj: keyof Props | Props, value?: AllPropTypes<Props>): this {
        if (typeof keyOrObj === 'string') {
            this.attrKV(keyOrObj as keyof ElementProps, value as AllPropTypes<ElementProps>);
        }
        else if (isObject(keyOrObj)) {
            let obj = keyOrObj as object;
            let keysArr = keys(obj);
            for (let i = 0; i < keysArr.length; i++) {
                let key = keysArr[i];
                this.attrKV(key as keyof ElementProps, keyOrObj[key]);
            }
        }
        this.dirty();
        return this;
    }

    getClipPath() {
        return this._clipPath;
    }

    setClipPath(clipPath: Path) {
        const zr = this.__zr;
        if (zr) {
            clipPath.addSelfToZr(zr);
        }

        // Remove previous clip path
        if (this._clipPath && this._clipPath !== clipPath) {
            this.removeClipPath();
        }

        this._clipPath = clipPath;
        clipPath.__zr = zr;
        // TODO
        clipPath.__clipTarget = this as unknown as Element;

        this.dirty();
    }

    removeClipPath() {
        const clipPath = this._clipPath;
        if (clipPath) {
            if (clipPath.__zr) {
                clipPath.removeSelfFromZr(clipPath.__zr);
            }

            clipPath.__zr = null;
            clipPath.__clipTarget = null;
            this._clipPath = null;

            this.dirty();
        }
    }

    getTextContent(): RichText {
        return this._textContent;
    }

    setTextContent(textEl: RichText) {
        // Remove previous clip path
        if (this._textContent && this._textContent !== textEl) {
            this.removeTextContent();
        }

        const zr = this.__zr;
        if (zr) {
            textEl.addSelfToZr(zr);
        }

        this._textContent = textEl;
        textEl.__zr = zr;

        this.dirty();
    }

    removeTextContent() {
        const textEl = this._textContent;
        if (textEl) {
            if (textEl.__zr) {
                textEl.removeSelfFromZr(textEl.__zr);
            }
            textEl.__zr = null;
            this._textContent = null;
            this.dirty();
        }
    }

    setTextLayout(textLayout: TextLayout) {
        if (!this.textLayout) {
            this.textLayout = {};
        }
        extend(this.textLayout, textLayout);
        this.dirty();
    }

    /**
     * Mark displayable element dirty and refresh next frame
     */
    dirty() {
        this.__dirty = true;
        this.__zr && this.__zr.refresh();
    }

    /**
     * Add self from zrender instance.
     * Not recursively because it will be invoked when element added to storage.
     */
    addSelfToZr(zr: ZRenderType) {
        this.__zr = zr;
        // 添加动画
        const animators = this.animators;
        if (animators) {
            for (let i = 0; i < animators.length; i++) {
                zr.animation.addAnimator(animators[i]);
            }
        }

        if (this._clipPath) {
            this._clipPath.addSelfToZr(zr);
        }
        if (this._textContent) {
            this._textContent.addSelfToZr(zr);
        }
    }

    /**
     * Remove self from zrender instance.
     * Not recursively because it will be invoked when element added to storage.
     */
    removeSelfFromZr(zr: ZRenderType) {
        this.__zr = null;
        // 移除动画
        const animators = this.animators;
        if (animators) {
            for (let i = 0; i < animators.length; i++) {
                zr.animation.removeAnimator(animators[i]);
            }
        }

        if (this._clipPath) {
            this._clipPath.removeSelfFromZr(zr);
        }
        if (this._textContent) {
            this._textContent.removeSelfFromZr(zr);
        }
    }

    /**
     * 动画
     *
     * @param path The key to fetch value from object. Mostly style or shape.
     * @param loop Whether to loop animation.
     * @example:
     *     el.animate('style', false)
     *         .when(1000, {x: 10} )
     *         .done(function(){ // Animation done })
     *         .start()
     */
    animate(key?: keyof this, loop?: boolean) {
        let target = key ? this[key] : this;

        if (!target) {
            logError(
                'Property "'
                + key
                + '" is not existed in element '
                + this.id
            );
            return;
        }

        const animator = new Animator(target, loop);
        this.addAnimator(animator, key);
        return animator;
    }

    addAnimator<T extends keyof this>(animator: Animator<this | this[T]>, key: T): void {
        const zr = this.__zr;

        const el = this;
        const animators = el.animators;

        // TODO Can improve performance?
        animator.during(function () {
            el.updateDuringAnimation(key as string);
        }).done(function () {
            // FIXME Animator will not be removed if use `Animator#stop` to stop animation
            animators.splice(indexOf(animators, animator), 1);
        });

        animators.push(animator);

        // If animate after added to the zrender
        if (zr) {
            zr.animation.addAnimator(animator);
        }
    }

    updateDuringAnimation(key: string) {
        this.dirty();
    }

    /**
     * 停止动画
     * @param {boolean} forwardToLast If move to last frame before stop
     */
    stopAnimation(forwardToLast?: boolean) {
        const animators = this.animators;
        const len = animators.length;
        for (let i = 0; i < len; i++) {
            animators[i].stop(forwardToLast);
        }
        animators.length = 0;

        return this;
    }

    /**
     * Caution: this method will stop previous animation.
     * So do not use this method to one element twice before
     * animation starts, unless you know what you are doing.
     *
     * @example
     *  // Animate position
     *  el.animateTo({
     *      position: [10, 10]
     *  }, function () { // done })
     *
     *  // Animate shape, style and position in 100ms, delayed 100ms, with cubicOut easing
     *  el.animateTo({
     *      shape: {
     *          width: 500
     *      },
     *      style: {
     *          fill: 'red'
     *      }
     *      position: [10, 10]
     *  }, 100, 100, 'cubicOut', function () { // done })
     */

    // Overload definitions
    animateTo(target: Props): void
    animateTo(target: Props, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number): void
    animateTo(target: Props, time: number, easing: AnimationEasing): void
    animateTo(target: Props, time: number, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number, callback: AnimationCallback): void
    animateTo(target: Props, time: number, easing: AnimationEasing, callback: AnimationCallback): void
    animateTo(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback): void
    // eslint-disable-next-line
    animateTo(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback, forceAnimate: boolean): void

    // TODO Return animation key
    animateTo(
        target: Props,
        time?: number | AnimationCallback,  // Time in ms
        delay?: AnimationEasing | number | AnimationCallback,
        easing?: AnimationEasing | number | AnimationCallback,
        callback?: AnimationCallback,
        forceAnimate?: boolean // Prevent stop animation and callback
                                // immediently when target values are the same as current values.
    ) {
        animateTo(this, target, time, delay, easing, callback, forceAnimate);
    }

    /**
     * Animate from the target state to current state.
     * The params and the return value are the same as `this.animateTo`.
     */

    // Overload definitions
    animateFrom(target: Props): void
    animateFrom(target: Props, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number): void
    animateFrom(target: Props, time: number, easing: AnimationEasing): void
    animateFrom(target: Props, time: number, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, easing: AnimationEasing, callback: AnimationCallback): void
    animateFrom(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback): void
    // eslint-disable-next-line
    animateFrom(target: Props, time: number, delay: number, easing: AnimationEasing, callback: AnimationCallback, forceAnimate: boolean): void

    animateFrom(
        target: Props,
        time?: number | AnimationCallback,
        delay?: AnimationEasing | number | AnimationCallback,
        easing?: AnimationEasing | number | AnimationCallback,
        callback?: AnimationCallback,
        forceAnimate?: boolean
    ) {
        animateTo(this, target, time, delay, easing, callback, forceAnimate, true);
    }

    /**
     * Interface of getting the minimum bounding box.
     */
    getBoundingRect(): BoundingRect {
        return null;
    }

    protected static initDefaultProps = (function () {
        const elProto = Element.prototype;
        elProto.type = 'element';
        elProto.name = '';
        elProto.ignore = false;
        elProto.silent = false;
        elProto.isGroup = false;
        elProto.draggable = false;
        elProto.dragging = false;
        elProto.__dirty = true;
    })()
}

mixin(Element, Eventful);
mixin(Element, Transformable);

function animateTo<T>(
    animatable: Element<T>,
    target: Dictionary<any>,
    time: number | AnimationCallback,
    delay: AnimationEasing | number | AnimationCallback,
    easing: AnimationEasing | number | AnimationCallback,
    callback: AnimationCallback,
    forceAnimate: boolean,
    reverse?: boolean
) {
    // animateTo(target, time, easing, callback);
    if (isString(delay)) {
        callback = easing as AnimationCallback;
        easing = delay as AnimationEasing;
        delay = 0;
    }
    // animateTo(target, time, delay, callback);
    else if (isFunction(easing)) {
        callback = easing as AnimationCallback;
        easing = 'linear';
        delay = 0;
    }
    // animateTo(target, time, callback);
    else if (isFunction(delay)) {
        callback = delay as AnimationCallback;
        delay = 0;
    }
    // animateTo(target, callback)
    else if (isFunction(time)) {
        callback = time as AnimationCallback;
        time = 500;
    }
    // animateTo(target)
    else if (!time) {
        time = 500;
    }
    // Stop all previous animations
    animatable.stopAnimation();
    animateToShallow(animatable, '', animatable, target, time as number, delay as number, reverse);

    // Animators may be removed immediately after start
    // if there is nothing to animate
    const animators = animatable.animators;
    let count = animators.length;
    function done() {
        count--;
        if (!count) {
            callback && callback();
        }
    }

    // No animators. This should be checked before animators[i].start(),
    // because 'done' may be executed immediately if no need to animate.
    if (!count) {
        callback && callback();
    }
    // Start after all animators created
    // Incase any animator is done immediately when all animation properties are not changed
    for (let i = 0; i < animators.length; i++) {
        animators[i]
            .done(done)
            .start(<AnimationEasing>easing, forceAnimate);
    }
}

/**
 * @example
 *  // Animate position
 *  el._animateToShallow({
 *      position: [10, 10]
 *  })
 *
 *  // Animate shape, style and position in 100ms, delayed 100ms
 *  el._animateToShallow({
 *      shape: {
 *          width: 500
 *      },
 *      style: {
 *          fill: 'red'
 *      }
 *      position: [10, 10]
 *  }, 100, 100)
 */
function animateToShallow<T>(
    animatable: Element<T>,
    topKey: string,
    source: Dictionary<any>,
    target: Dictionary<any>,
    time: number,
    delay: number,
    reverse: boolean    // If `true`, animate from the `target` to current state.
) {
    const animatableKeys: string[] = [];
    let targetKeys = keys(target);
    for (let k = 0; k < targetKeys.length; k++) {
        let innerKey = targetKeys[k] as string;

        if (source[innerKey] != null) {
            if (isObject(target[innerKey]) && !isArrayLike(target[innerKey])) {
                // if (topKey) {
                //     throw new Error('Only support 1 depth nest object animation.');
                // }
                animateToShallow(
                    animatable,
                    innerKey,
                    source[innerKey],
                    target[innerKey],
                    time,
                    delay,
                    reverse
                );
            }
            else {
                animatableKeys.push(innerKey);
            }
        }
        else if (target[innerKey] != null && !reverse) {
            // Assign directly.
            source[innerKey] = target[innerKey];
        }
    }

    let keyLen = animatableKeys.length;
    let reversedTarget: Dictionary<any>;
    if (reverse) {
        reversedTarget = {};
        for (let i = 0; i < keyLen; i++) {
            let innerKey = animatableKeys[i];
            reversedTarget[innerKey] = source[innerKey];
            // Animate from target
            source[innerKey] = target[innerKey];
        }
    }

    if (keyLen > 0) {
        const animator = new Animator(source, false);
        animator.whenWithKeys(
            time == null ? 500 : time,
            reverse ? reversedTarget : target,
            animatableKeys
        ).delay(delay || 0);
        animatable.addAnimator(animator, topKey as any);
    }
}


export default Element;