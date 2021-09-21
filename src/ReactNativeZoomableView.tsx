import React, { Component, createRef, RefObject } from 'react';
import {
  Animated,
  GestureResponderEvent,
  InteractionManager,
  PanResponder,
  PanResponderGestureState,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import {
  Vec2D,
  ReactNativeZoomableViewProps,
  ReactNativeZoomableViewState,
  TouchPoint,
  ZoomableViewEvent,
} from '@openspacelabs/react-native-zoomable-view';

import { AnimatedTouchFeedback } from './components';
import { DebugTouchPoint } from './debugHelper';
import { calcGestureCenterPoint, calcGestureTouchDistance, calcNewScaledOffsetForZoomCentering } from './helper';
import { applyPanBoundariesToOffset } from './helper/applyPanBoundariesToOffset';
import { getBoundaryCrossedAnim, getPanMomentumDecayAnim, getZoomToAnimation } from './animations';

const initialState = {
  originalWidth: null,
  originalHeight: null,
  originalPageX: null,
  originalPageY: null,
} as ReactNativeZoomableViewState;

class ReactNativeZoomableView extends Component<ReactNativeZoomableViewProps, ReactNativeZoomableViewState> {
  zoomSubjectRef: RefObject<View>;
  gestureHandlers: any;
  doubleTapFirstTapReleaseTimestamp: number;

  static defaultProps = {
    zoomEnabled: true,
    initialZoom: 1,
    initialOffsetX: 0,
    initialOffsetY: 0,
    maxZoom: 1.5,
    minZoom: 0.5,
    pinchToZoomInSensitivity: 3,
    pinchToZoomOutSensitivity: 1,
    movementSensibility: 1.9,
    doubleTapDelay: 300,
    bindToBorders: true,
    zoomStep: 0.5,
    onLongPress: null,
    longPressDuration: 700,
    captureEvent: false,
  };

  private panAnim = new Animated.ValueXY({ x: 0, y: 0 });
  private zoomAnim = new Animated.Value(1);

  private __offsets = {
    x: {
      value: 0,
      boundaryCrossedAnimInEffect: false,
    },
    y: {
      value: 0,
      boundaryCrossedAnimInEffect: false,
    },
  };

  private zoomLevel = 1;
  private lastGestureCenterPosition: { x: number; y: number } = null;
  private lastGestureTouchDistance: number;
  private gestureType: 'pinch' | 'shift' | 'null';
  private gestureStarted = false;

  /**
   * Last press time (used to evaluate whether user double tapped)
   * @type {number}
   */
  private longPressTimeout: NodeJS.Timeout = null;
  private onTransformInvocationInitialized: boolean;
  private singleTapTimeoutId: NodeJS.Timeout;
  private touches: TouchPoint[] = [];
  private doubleTapFirstTap: TouchPoint;

  constructor(props) {
    super(props);

    this.gestureHandlers = PanResponder.create({
      onStartShouldSetPanResponder: this._handleStartShouldSetPanResponder,
      onMoveShouldSetPanResponder: this._handleMoveShouldSetPanResponder,
      onPanResponderGrant: this._handlePanResponderGrant,
      onPanResponderMove: this._handlePanResponderMove,
      onPanResponderRelease: this._handlePanResponderEnd,
      onPanResponderTerminate: props.onPanResponderTerminate,
      onPanResponderTerminationRequest: props.onPanResponderTerminationRequest ?? ((evt) => false),
      onShouldBlockNativeResponder: (evt) => false,
    });

    this.zoomSubjectRef = createRef<View>();

    this.zoomLevel = props.initialZoom;
    this.offsetX = props.initialOffsetX;
    this.offsetY = props.initialOffsetY;

    this.panAnim.setValue({ x: this.offsetX, y: this.offsetY });
    this.zoomAnim.setValue(this.zoomLevel);
    this.panAnim.addListener(({ x, y }) => {
      this.offsetX = x;
      this.offsetY = y;
    });
    this.zoomAnim.addListener(({ value }) => {
      this.zoomLevel = value;
    });

    // eslint-disable-next-line react/state-in-constructor
    this.state = {
      ...initialState,
    };

    this.lastGestureTouchDistance = 150;

    this.gestureType = null;
  }

  private set offsetX(x: number) {
    this.__setOffset('x', x);
  }
  private set offsetY(y: number) {
    this.__setOffset('y', y);
  }
  private get offsetX() {
    return this.__getOffset('x');
  }
  private get offsetY() {
    return this.__getOffset('y');
  }
  private __setOffset(axis: 'x' | 'y', offset) {
    const containerSize = axis === 'x' ? this.state?.originalWidth : this.state?.originalHeight;
    const contentSize =
      axis === 'x'
        ? this.props.contentWidth || this.state?.originalWidth
        : this.props.contentHeight || this.state?.originalHeight;

    const boundOffset =
      contentSize && containerSize
        ? applyPanBoundariesToOffset(offset, containerSize, contentSize, this.zoomLevel)
        : offset;

    const offsetState = this.__offsets[axis];
    const animValue = this.panAnim?.[axis];

    if (animValue && !this.gestureType && !offsetState.boundaryCrossedAnimInEffect) {
      const boundariesApplied = boundOffset !== offset && boundOffset.toFixed(3) !== offset.toFixed(3);
      if (boundariesApplied) {
        offsetState.boundaryCrossedAnimInEffect = true;
        getBoundaryCrossedAnim(this.panAnim[axis], boundOffset).start(() => {
          offsetState.boundaryCrossedAnimInEffect = false;
        });
        return;
      }
    }

    offsetState.value = offset;
  }
  private __getOffset(axis: 'x' | 'y') {
    return this.__offsets[axis].value;
  }

  componentDidUpdate(prevProps: ReactNativeZoomableViewProps) {
    const { zoomEnabled, initialZoom } = this.props;
    if (prevProps.zoomEnabled && !zoomEnabled) {
      this.zoomLevel = initialZoom;
      this.zoomAnim.setValue(this.zoomLevel);
    }
    if (!this.onTransformInvocationInitialized && this._invokeOnTransform().successful) {
      this.panAnim.addListener(() => this._invokeOnTransform());
      this.zoomAnim.addListener(() => this._invokeOnTransform());
      this.onTransformInvocationInitialized = true;
    }
  }

  componentDidMount() {
    InteractionManager.runAfterInteractions(() => {
      this._getBoxDimensions();
    });
  }

  /**
   * try to invoke onTransform
   * @private
   */
  _invokeOnTransform() {
    const zoomableViewEvent = this._getZoomableViewEventObject();

    if (!zoomableViewEvent.originalWidth || !zoomableViewEvent.originalHeight) return { successful: false };

    this.props.onTransform?.(zoomableViewEvent);

    return { successful: true };
  }

  /**
   * Returns additional information about components current state for external event hooks
   *
   * @returns {{}}
   * @private
   */
  _getZoomableViewEventObject(overwriteObj = {}): ZoomableViewEvent {
    return {
      zoomLevel: this.zoomLevel,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      originalHeight: this.state.originalHeight,
      originalWidth: this.state.originalWidth,
      originalPageX: this.state.originalPageX,
      originalPageY: this.state.originalPageY,
      ...overwriteObj,
    } as ZoomableViewEvent;
  }

  /**
   * Get the original box dimensions and save them for later use.
   * (They will be used to calculate boxBorders)
   *
   * @private
   */
  _getBoxDimensions = () => {
    this.zoomSubjectRef.current.measureInWindow((x, y, width, height) => {
      this.setState({
        originalWidth: width,
        originalHeight: height,
        originalPageX: x,
        originalPageY: y,
      });
    });
  };

  /**
   * Handles the start of touch events and checks for taps
   *
   * @param e
   * @param gestureState
   * @returns {boolean}
   *
   * @private
   */
  _handleStartShouldSetPanResponder = (e: GestureResponderEvent, gestureState: PanResponderGestureState) => {
    if (this.props.onStartShouldSetPanResponder) {
      this.props.onStartShouldSetPanResponder(e, gestureState, this._getZoomableViewEventObject(), false);
    }

    return this.props.captureEvent;
  };

  /**
   * Checks if the movement responder should be triggered
   *
   * @param e
   * @param gestureState
   * @returns {Boolean|boolean}
   */
  _handleMoveShouldSetPanResponder = (e: GestureResponderEvent, gestureState: PanResponderGestureState) => {
    let baseComponentResult =
      this.props.zoomEnabled &&
      (Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2 || gestureState.numberActiveTouches === 2);

    if (this.props.onMoveShouldSetPanResponder) {
      baseComponentResult = this.props.onMoveShouldSetPanResponder(
        e,
        gestureState,
        this._getZoomableViewEventObject(),
        baseComponentResult,
      );
    }

    return baseComponentResult;
  };

  /**
   * Calculates pinch distance
   *
   * @param e
   * @param gestureState
   * @private
   */
  _handlePanResponderGrant = (e, gestureState) => {
    if (this.props.onLongPress) {
      this.longPressTimeout = setTimeout(() => {
        this.props.onLongPress?.(e, gestureState, this._getZoomableViewEventObject());
        this.longPressTimeout = null;
      }, this.props.longPressDuration);
    }

    this.props.onPanResponderGrant?.(e, gestureState, this._getZoomableViewEventObject());

    this.panAnim.stopAnimation();
    this.zoomAnim.stopAnimation();
    this.gestureStarted = true;
  };

  /**
   * Handles the end of touch events
   *
   * @param e
   * @param gestureState
   *
   * @private
   */
  _handlePanResponderEnd = (e, gestureState) => {
    this.lastGestureCenterPosition = null;

    getPanMomentumDecayAnim(this.panAnim, {
      x: gestureState.vx / this.zoomLevel,
      y: gestureState.vy / this.zoomLevel,
    }).start();

    if (this.longPressTimeout) {
      clearTimeout(this.longPressTimeout);
      this.longPressTimeout = null;
    }

    this.props.onPanResponderEnd?.(e, gestureState, this._getZoomableViewEventObject());

    if (this.gestureType === 'pinch') {
      this.props.onZoomEnd?.(e, gestureState, this._getZoomableViewEventObject());
    } else if (this.gestureType === 'shift') {
      this.props.onShiftingEnd?.(e, gestureState, this._getZoomableViewEventObject());
    }

    this.gestureType = null;
    this.gestureStarted = false;
  };

  /**
   * Handles the actual movement of our pan responder
   *
   * @param e
   * @param gestureState
   *
   * @private
   */
  _handlePanResponderMove = (
    e: GestureResponderEvent,
    gestureState: PanResponderGestureState,
    // eslint-disable-next-line consistent-return
  ) => {
    if (this.props.onPanResponderMove) {
      if (this.props.onPanResponderMove(e, gestureState, this._getZoomableViewEventObject())) {
        return false;
      }
    }

    // Only supports 2 touches and below,
    // any invalid number will cause the gesture to end.
    if (gestureState.numberActiveTouches <= 2) {
      if (!this.gestureStarted) {
        this._handlePanResponderGrant(e, gestureState);
      }
    } else {
      if (this.gestureStarted) {
        this._handlePanResponderEnd(e, gestureState);
      }
      return true;
    }

    if (gestureState.numberActiveTouches === 2) {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }

      // change some measurement states when switching gesture to ensure a smooth transition
      if (this.gestureType !== 'pinch') {
        this.lastGestureCenterPosition = calcGestureCenterPoint(e, gestureState);
        this.lastGestureTouchDistance = calcGestureTouchDistance(e, gestureState);
      }
      this.gestureType = 'pinch';
      this._handlePinching(e, gestureState);
    } else if (gestureState.numberActiveTouches === 1) {
      if (this.longPressTimeout && (Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5)) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
      // change some measurement states when switching gesture to ensure a smooth transition
      if (this.gestureType !== 'shift') {
        this.lastGestureCenterPosition = calcGestureCenterPoint(e, gestureState);
      }
      this.gestureType = 'shift';
      this._handleShifting(gestureState);
    }
  };

  /**
   * Handles the pinch movement and zooming
   *
   * @param e
   * @param gestureState
   *
   * @private
   */
  _handlePinching(e: GestureResponderEvent, gestureState: PanResponderGestureState) {
    const { maxZoom, minZoom, pinchToZoomInSensitivity, pinchToZoomOutSensitivity } = this.props;

    const distance = calcGestureTouchDistance(e, gestureState);

    if (this.props.onZoomBefore && this.props.onZoomBefore(e, gestureState, this._getZoomableViewEventObject())) {
      return;
    }

    // define the new zoom level and take zoom level sensitivity into consideration
    const zoomGrowthFromLastGestureState = distance / this.lastGestureTouchDistance;
    this.lastGestureTouchDistance = distance;

    const pinchToZoomSensitivity =
      zoomGrowthFromLastGestureState < 1 ? pinchToZoomOutSensitivity : pinchToZoomInSensitivity;

    const deltaGrowth = zoomGrowthFromLastGestureState - 1;
    // 0 - no resistance
    // 10 - 90% resistance
    const deltaGrowthAdjustedBySensitivity = deltaGrowth * (1 - (pinchToZoomSensitivity * 9) / 100);

    let newZoomLevel = this.zoomLevel * (1 + deltaGrowthAdjustedBySensitivity);

    // make sure max and min zoom levels are respected
    if (maxZoom !== null && newZoomLevel > maxZoom) {
      newZoomLevel = maxZoom;
    }

    if (newZoomLevel < minZoom) {
      newZoomLevel = minZoom;
    }

    const gestureCenterPoint = calcGestureCenterPoint(e, gestureState);

    const zoomCenter = {
      x: gestureCenterPoint.x - this.state.originalPageX,
      y: gestureCenterPoint.y - this.state.originalPageY,
    };

    // Uncomment to debug
    this.props.debug && this._setPinchDebugPoints(e, zoomCenter);

    const { originalHeight, originalWidth } = this.state;

    const oldOffsetX = this.offsetX;
    const oldOffsetY = this.offsetY;
    const oldScale = this.zoomLevel;
    const newScale = newZoomLevel;

    let offsetY = calcNewScaledOffsetForZoomCentering(oldOffsetY, originalHeight, oldScale, newScale, zoomCenter.y);
    let offsetX = calcNewScaledOffsetForZoomCentering(oldOffsetX, originalWidth, oldScale, newScale, zoomCenter.x);

    const offsetShift = this._calcOffsetShiftSinceLastGestureState(gestureCenterPoint);
    if (offsetShift) {
      offsetX += offsetShift.x;
      offsetY += offsetShift.y;
    }

    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.zoomLevel = newScale;

    this.panAnim.setValue({ x: this.offsetX, y: this.offsetY });
    this.zoomAnim.setValue(this.zoomLevel);

    this.props.onZoomAfter?.(e, gestureState, this._getZoomableViewEventObject());
  }

  /**
   * Used to debug pinch events
   * @param gestureResponderEvent
   * @param zoomCenter
   * @param points
   */
  _setPinchDebugPoints(gestureResponderEvent: GestureResponderEvent, zoomCenter: Vec2D, ...points: Vec2D[]) {
    const { touches } = gestureResponderEvent.nativeEvent;
    const { originalPageY, originalPageX } = this.state;
    this.setState({
      debugPoints: [
        {
          x: touches[0].pageX - originalPageX,
          y: touches[0].pageY - originalPageY,
        },
        {
          x: touches[1].pageX - originalPageX,
          y: touches[1].pageY - originalPageY,
        },
        zoomCenter,
        ...points,
      ],
    });
  }

  /**
   * Calculates the amount the offset should shift since the last position during panning
   *
   * @param {Vec2D} gestureCenterPoint
   *
   * @private
   */
  _calcOffsetShiftSinceLastGestureState(gestureCenterPoint: Vec2D) {
    const { movementSensibility } = this.props;

    let shift = null;

    if (this.lastGestureCenterPosition) {
      const dx = gestureCenterPoint.x - this.lastGestureCenterPosition.x;
      const dy = gestureCenterPoint.y - this.lastGestureCenterPosition.y;

      const shiftX = dx / this.zoomLevel / movementSensibility;
      const shiftY = dy / this.zoomLevel / movementSensibility;

      shift = {
        x: shiftX,
        y: shiftY,
      };
    }

    this.lastGestureCenterPosition = gestureCenterPoint;

    return shift;
  }

  /**
   * Handles movement by tap and move
   *
   * @param gestureState
   *
   * @private
   */
  _handleShifting(gestureState: PanResponderGestureState) {
    const shift = this._calcOffsetShiftSinceLastGestureState({
      x: gestureState.moveX,
      y: gestureState.moveY,
    });
    if (!shift) return;

    const offsetX = this.offsetX + shift.x;
    const offsetY = this.offsetY + shift.y;

    this._setNewOffsetPosition(offsetX, offsetY, this.props.bindToBorders);
  }

  /**
   * Set the state to offset moved
   *
   * @param {number} newOffsetX
   * @param {number} newOffsetY
   * @param {bool} bindToBorders
   * @param {() => void)} callback
   * @returns
   */
  _setNewOffsetPosition(newOffsetX: number, newOffsetY: number, bindToBorders = true, callback: () => void = null) {
    const { onShiftingBefore, onShiftingAfter } = this.props;

    if (onShiftingBefore?.(null, null, this._getZoomableViewEventObject())) {
      return;
    }

    this.offsetX = newOffsetX;
    this.offsetY = newOffsetY;

    this.panAnim.setValue({ x: this.offsetX, y: this.offsetY });
    this.zoomAnim.setValue(this.zoomLevel);

    callback?.();
    onShiftingAfter?.(null, null, this._getZoomableViewEventObject());
  }

  /**
   * Check whether the press event is double tap
   * or single tap and handle the event accordingly
   *
   * @param e
   *
   * @private
   */
  private _resolveAndHandleTap = (e: GestureResponderEvent) => {
    const now = Date.now();
    if (
      this.doubleTapFirstTapReleaseTimestamp &&
      now - this.doubleTapFirstTapReleaseTimestamp < this.props.doubleTapDelay
    ) {
      this._addTouch({
        ...this.doubleTapFirstTap,
        id: now.toString(),
        isSecondTap: true,
      });
      clearTimeout(this.singleTapTimeoutId);
      delete this.doubleTapFirstTapReleaseTimestamp;
      delete this.singleTapTimeoutId;
      delete this.doubleTapFirstTap;
      this._handleDoubleTap(e);
    } else {
      this.doubleTapFirstTapReleaseTimestamp = now;
      this.doubleTapFirstTap = {
        id: now.toString(),
        x: e.nativeEvent.pageX - this.state.originalPageX,
        y: e.nativeEvent.pageY - this.state.originalPageY,
      };
      this._addTouch(this.doubleTapFirstTap);

      // persist event so e.nativeEvent is preserved after a timeout delay
      e.persist();
      this.singleTapTimeoutId = setTimeout(() => {
        delete this.doubleTapFirstTapReleaseTimestamp;
        delete this.singleTapTimeoutId;
        this.props.onSingleTap?.(e, this._getZoomableViewEventObject());
      }, this.props.doubleTapDelay);
    }
  };

  private _addTouch(touch: TouchPoint) {
    this.touches.push(touch);
    this.setState({ touches: [...this.touches] });
  }

  private _removeTouch(touch: TouchPoint) {
    this.touches.splice(this.touches.indexOf(touch), 1);
    this.setState({ touches: [...this.touches] });
  }

  /**
   * Handles the double tap event
   *
   * @param e
   *
   * @private
   */
  _handleDoubleTap(e: GestureResponderEvent) {
    const { onDoubleTapBefore, onDoubleTapAfter, doubleTapZoomToCenter } = this.props;

    onDoubleTapBefore?.(e, this._getZoomableViewEventObject());

    const nextZoomStep = this._getNextZoomStep();
    const { originalPageX, originalPageY } = this.state;

    // define new zoom position coordinates
    const zoomPositionCoordinates = {
      x: e.nativeEvent.pageX - originalPageX,
      y: e.nativeEvent.pageY - originalPageY,
    };

    // if doubleTapZoomToCenter enabled -> always zoom to center instead
    if (doubleTapZoomToCenter) {
      zoomPositionCoordinates.x = 0;
      zoomPositionCoordinates.y = 0;
    }

    this._zoomToLocation(
      zoomPositionCoordinates.x,
      zoomPositionCoordinates.y,
      nextZoomStep,
      this.props.bindToBorders,
      () => {
        onDoubleTapAfter?.(
          e,
          this._getZoomableViewEventObject({
            zoomLevel: nextZoomStep,
          }),
        );
      },
    );
  }

  /**
   * Returns the next zoom step based on current step and zoomStep property.
   * If we are zoomed all the way in -> return to initialzoom
   *
   * @returns {*}
   */
  _getNextZoomStep() {
    const { zoomStep, maxZoom, initialZoom } = this.props;
    const { zoomLevel } = this;

    if (zoomLevel.toFixed(2) === maxZoom.toFixed(2)) {
      return initialZoom;
    }

    const nextZoomStep = zoomLevel * (1 + zoomStep);
    if (nextZoomStep > maxZoom) {
      return maxZoom;
    }

    return nextZoomStep;
  }

  /**
   * Zooms to a specific location in our view
   *
   * @param x
   * @param y
   * @param newZoomLevel
   * @param bindToBorders
   * @param callbk
   *
   * @private
   */
  _zoomToLocation(x: number, y: number, newZoomLevel: number, bindToBorders = true, callbk: () => void = null) {
    this.props.onZoomBefore?.(null, null, this._getZoomableViewEventObject());

    // == Perform Zoom Animation ==
    // Calculates panAnim values based on changes in zoomAnim.
    let prevScale = this.zoomLevel;
    // Since zoomAnim is calculated in native driver,
    //  it will jitter panAnim once in a while,
    //  because here panAnim is being calculated in js.
    // However the jittering should mostly occur in simulator.
    const listenerId = this.zoomAnim.addListener(({ value: newScale }) => {
      this.panAnim.setValue({
        x: calcNewScaledOffsetForZoomCentering(this.offsetX, this.state.originalWidth, prevScale, newScale, x),
        y: calcNewScaledOffsetForZoomCentering(this.offsetY, this.state.originalHeight, prevScale, newScale, y),
      });
      prevScale = newScale;
    });
    getZoomToAnimation(this.zoomAnim, newZoomLevel).start(() => {
      this.zoomAnim.removeListener(listenerId);
    });
    // == Zoom Animation Ends ==

    callbk?.();
    this.props.onZoomAfter?.(null, null, this._getZoomableViewEventObject());
  }

  /**
   * Zooms to a specificied zoom level.
   * Returns a promise if everything was updated and a boolean, whether it could be updated or if it exceeded the min/max zoom limits.
   *
   * @param {number} newZoomLevel
   * @param {bool} bindToBorders
   *
   * @return {Promise<bool>}
   */
  zoomTo(newZoomLevel: number, bindToBorders = true): Promise<boolean> {
    return new Promise((resolve) => {
      // if we would go out of our min/max limits -> abort
      if (newZoomLevel >= this.props.maxZoom || newZoomLevel <= this.props.minZoom) {
        resolve(false);
        return;
      }

      this._zoomToLocation(0, 0, newZoomLevel, bindToBorders, () => {
        resolve(true);
      });
    });
  }

  /**
   * Zooms in or out by a specified change level
   * Use a positive number for `zoomLevelChange` to zoom in
   * Use a negative number for `zoomLevelChange` to zoom out
   *
   * Returns a promise if everything was updated and a boolean, whether it could be updated or if it exceeded the min/max zoom limits.
   *
   * @param {number | null} zoomLevelChange
   * @param {bool} bindToBorders
   *
   * @return {Promise<bool>}
   */
  zoomBy(zoomLevelChange: number = null, bindToBorders = true): Promise<boolean> {
    // if no zoom level Change given -> just use zoom step
    if (!zoomLevelChange) {
      zoomLevelChange = this.props.zoomStep;
    }

    return this.zoomTo(this.zoomLevel + zoomLevelChange, bindToBorders);
  }

  /**
   * Moves the zoomed view to a specified position
   * Returns a promise when finished
   *
   * @param {number} newOffsetX the new position we want to move it to (x-axis)
   * @param {number} newOffsetY the new position we want to move it to (y-axis)
   * @param {bool} bindToBorders
   *
   * @return {Promise<bool>}
   */
  moveTo(newOffsetX: number, newOffsetY: number, bindToBorders = true): Promise<void> {
    const { originalWidth, originalHeight } = this.state;

    const offsetX = (newOffsetX - originalWidth / 2) / this.zoomLevel;
    const offsetY = (newOffsetY - originalHeight / 2) / this.zoomLevel;

    return new Promise((resolve) => {
      this._setNewOffsetPosition(-offsetX, -offsetY, bindToBorders, resolve);
    });
  }

  /**
   * Moves the zoomed view by a certain amount.
   *
   * Returns a promise when finished
   *
   * @param {number} offsetChangeX the amount we want to move the offset by (x-axis)
   * @param {number} offsetChangeY the amount we want to move the offset by (y-axis)
   * @param {bool} bindToBorders
   *
   * @return {Promise<bool>}
   */
  moveBy(offsetChangeX: number, offsetChangeY: number, bindToBorders = true): Promise<void> {
    const offsetX = (this.offsetX * this.zoomLevel - offsetChangeX) / this.zoomLevel;
    const offsetY = (this.offsetY * this.zoomLevel - offsetChangeY) / this.zoomLevel;

    return new Promise((resolve) => {
      this._setNewOffsetPosition(offsetX, offsetY, bindToBorders, resolve);
    });
  }

  render() {
    return (
      <View style={styles.container} {...this.gestureHandlers.panHandlers}>
        <TouchableWithoutFeedback onPress={this._resolveAndHandleTap}>
          <Animated.View
            ref={this.zoomSubjectRef}
            onLayout={this._getBoxDimensions}
            style={[
              styles.wrapper,
              this.props.style,
              {
                transform: [{ scale: this.zoomAnim }, ...this.panAnim.getTranslateTransform()],
              },
            ]}
          >
            {this.props.children}
          </Animated.View>
        </TouchableWithoutFeedback>
        {this.state.touches?.map((touch) => {
          const animationDuration = this.props.doubleTapDelay;
          return (
            <AnimatedTouchFeedback
              x={touch.x}
              y={touch.y}
              key={touch.id}
              animationDuration={animationDuration}
              onAnimationDone={() => this._removeTouch(touch)}
            />
          );
        })}
        {/* For Debugging Only */}
        {(this.state.debugPoints || []).map(({ x, y }, index) => {
          // eslint-disable-next-line react/no-array-index-key
          return <DebugTouchPoint key={index} x={x} y={y} />;
        })}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
});

export default ReactNativeZoomableView;