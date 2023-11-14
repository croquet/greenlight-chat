/* eslint-disable nonblock-statement-body-position */
/* global Croquet AgoraRTC */

// v4
AgoraRTC.setLogLevel(1); // 1=INFO
AgoraRTC.enableLogUpload();

const { searchParams } = new URL(window.location);
const isBackdrop = searchParams.get('backdrop') !== null;
const isSpectator = searchParams.has('spectator');
const sessionConfiguration = {
    channelName: searchParams.get('channelName') || searchParams.get('c') || 'all',
    nickname: searchParams.get('nickname') || searchParams.get('n') || '',
    initials: searchParams.get('initials') || searchParams.get('i') || '',
    viewColor: searchParams.get('viewColor') || searchParams.get('userColor') || searchParams.get('h') || `hsl(${Math.floor(Math.random() * 255)}, 40%, 40%)`,
    mic: searchParams.get('mic') || searchParams.get('m') || (isBackdrop ? 'on' : 'off'),
    video: searchParams.get('video') || searchParams.get('v') || (isBackdrop ? 'on' : 'off'),
    innerWidth: searchParams.get('iw') || 0,
    innerHeight: searchParams.get('ih') || 0,
    requestName: searchParams.has('requestName'),
};

// some settings are determined by which html file was loaded to get here
const htmlConfig = window.htmlConfig || {};
const isVideoAllowed = !htmlConfig.audioOnly;
if (!isVideoAllowed) sessionConfiguration.video = 'unavailable'; // hard override
if (htmlConfig.resizeFrame) sessionConfiguration.resizeFrame = true;
if (htmlConfig.parentJoinLeave) sessionConfiguration.parentJoinLeave = true;

const cover = document.getElementById('cover'); // only in index.html, else null
const joinDialog = document.getElementById('joinDialog'); // only in audioOnly, microverse
const ui = document.getElementById('ui');

if (isSpectator) {
    sessionConfiguration.mic = 'off';
    sessionConfiguration.video = 'off';
    ui.classList.add('spectator');
}


/*
  in Agora v4, the notion of publishing and unpublishing a stream that could contain an audio and/or video track was replaced with the publishing and unpublishing of tracks separately.

  with Agora v3, the client needed to publish its stream - which combined audio and video tracks - whenever it wanted to be sending either audio or video.  if both audio and video were muted, it needed to ensure that its stream was unpublished.  with v4, a track needs to be published once, after which it can be enabled or disabled at will (to unmute and mute).  remote peers will receive a "user-published" event for any track that is published (presumably only if it is enabled at that point), and "user-unpublished" if it is later disabled or explicitly unpublished - e.g., to replace with an alternative track.

  migration guide at https://docs.agora.io/en/Interactive%20Broadcast/migration_guide_web_ng?platform=Web

  code examples https://github.com/AgoraIO/API-Examples-Web, especially
  https://github.com/AgoraIO/API-Examples-Web/blob/main/Demo/basicVideoCall/basicVideoCall.js
*/

class StreamMixerInput {
    // created for each local video source.  makes a
    // dedicated video element, and provides a draw()
    // method for drawing to the main canvas when
    // this source is online.
    constructor(stream, streamMixer) {
        this.stream = stream;
        this.streamMixer = streamMixer;

        if (stream.getVideoTracks().length) {
            this.alpha = 0;

            this.video = document.createElement('video');

            this.video.playsInline = true;
            this.video.muted = true;
            this.video.autoplay = true;

            this.video.onloadedmetadata = this.onloadedmetadata.bind(this);
            this.video.onplay = this.updateVideoSize.bind(this);
            this.video.onresize = this.onresize.bind(this);

            this.video.srcObject = stream;

            window.setTimeout(this.updateVideoSize.bind(this, true), 1000);
        }
    }

    get width() { return this.video ? this.stream.getVideoTracks()[0].getSettings().width : undefined; }
    get height() { return this.video ? this.stream.getVideoTracks()[0].getSettings().height : undefined; }
    get aspectRatio() { return this.video ? this.width / this.height : undefined; }

    onloadedmetadata() {
        this.video.loadedmetadata = true;
        this.updateVideoSize(true);
    }
    onresize() {
        this.updateVideoSize();
    }

    updateVideoSize(updateStreamMixer = false) {
        this.video.width = this.width;
        this.video.height = this.height;

        if (updateStreamMixer || this.alpha === 1) {
            this.streamMixer.aspectRatio = this.aspectRatio;
        }
    }

    draw(canvas) {
        if (this.video && this.alpha > 0) {
            const context = canvas.getContext('2d');
            context.save();

            context.globalAlpha = this.alpha;
            context.drawImage(this.video, 0, 0, this.width, this.height, 0, 0, canvas.width, canvas.height);

            context.restore();
        }
    }

    remove() {
        if (this.video) {
            this.video.pause();
            this.video.srcObject = null;
        }
    }
}

class StreamMixer {
    // for selecting - and, if necessary, blending - the
    // video for our local stream.
    constructor(streamManager) {
        this.streamManager = streamManager;
        this.inputs = [];
        this.canvases = [];

        this.canvas = document.createElement('canvas');
        this.canvas.classList.add('peerVideo');
        this.canvas.width = 640;
        this.canvas.height = 480;
        this.canvasContext = this.canvas.getContext('2d');

        this.frameRate = isBackdrop ? 30 : 12;

        this.canvasStream = this.canvas.captureStream(this.frameRate);
    }

    get filter() { return this.canvasContext.filter; }
    set filter(filter) { this.canvasContext.filter = filter; }

    get videoInputs() {return this.inputs.filter(input => input.video);}
    // get audioInputs() {return this.inputs.filter(input => input.audio);}

    getInputByStream(stream) {return this.inputs.find(input => input.stream === stream);}
    addStream(stream) {
        let input = this.getInputByStream(stream);
        if (!input) {
            input = new StreamMixerInput(stream, this);
            this.inputs.push(input);
            if (input.video) {
                input.video.play().catch(err => {
                    console.error(`video.play() failed`, err);
                    this.streamManager.chatManager.playBlocked(() => input.video.play());
                        });
            }
        }
        return input;
    }
    removeStream(stream) {
        const input = this.getInputByStream(stream);
        if (input) {
            input.remove();
            this.inputs.splice(this.inputs.indexOf(input), 1);
            return true;
        }
        return false;
    }

    get isDrawing() {return !!this.drawIntervalId;}
    startDrawing() {
        if (this.isDrawing) this.stopDrawing(false);

        this.drawIntervalId = window.setInterval(this.draw.bind(this), 1000 / this.frameRate);
    }
    draw() {
        this.updateSize();

        const compositingCanvas = this.canvas;
        /* eslint-disable-next-line no-self-assign */
        compositingCanvas.width = compositingCanvas.width; // clear

        // draw all the video inputs onto the working canvas
        this.videoInputs.forEach(videoInput => videoInput.draw(compositingCanvas));

        // add the waveform
        this.streamManager.drawWaveform(compositingCanvas);

        // copy the working canvas image to each output canvas
        this.canvases.forEach(canvas => {
            /* eslint-disable-next-line no-self-assign */
            canvas.width = canvas.width; // clear

            const context = canvas.getContext('2d');
            context.drawImage(compositingCanvas, 0, 0);
        });
    }
    stopDrawing(clearCanvas = true) {
        if (this.isDrawing) {
            window.clearInterval(this.drawIntervalId);
            delete this.drawIntervalId;

            if (clearCanvas) {
                const compositingCanvas = this.canvas;
                /* eslint-disable-next-line no-self-assign */
                compositingCanvas.width = compositingCanvas.width; // clear

                this.canvases.forEach(canvas => {
                    /* eslint-disable-next-line no-self-assign */
                    canvas.width = canvas.width; // clear
                });
            }
        }
    }

    addOutputCanvas(canvas) {
        if (!this.canvases.includes(canvas)) {
            canvas.width = this.width;
            canvas.height = this.height;
            this.canvases.push(canvas);
        }
    }
    removeOutputCanvas(canvas) {
        if (this.canvases.includes(canvas))
            this.canvases.splice(this.canvases.indexOf(canvas), 1);
    }

    get width() {return this.canvas.width;}
    set width(width) {
        if (this.width === width || width === 0) return;

        this._width = width;
        this._height = width / this.aspectRatio;

        this._updateSize = true;
    }

    get height() {return this.canvas.height;}
    set height(height) {
        if (this.height === height || height === 0) return;

        this._height = height;
        this._width = height * this.aspectRatio;

        this._updateSize = true;
    }

    get aspectRatio() {return this.width / this.height;}
    set aspectRatio(aspectRatio) {
        if (this.aspectRatio === aspectRatio || aspectRatio === 0) return;

        if (aspectRatio > 1) {
            this._width = this.length;
            this._height = this._width / aspectRatio;
        } else {
            this._height = this.length;
            this._width = this._height * aspectRatio;
        }

        this._updateSize = true;
    }

    get length() {return Math.max(100, Math.max(this.width, this.height));}
    set length(length) {
        if (this.length === length || length === 0) return;

        if (this.aspectRatio > 1) {
            this._width = length;
            this._height = this._width / this.aspectRatio;
        } else {
            this._height = length;
            this._width = this._height * this.aspectRatio;
        }

        this._updateSize = true;
    }

    updateSize() {
        // @@ put back the isNaNs.  sort it out later.
        if (this._updateSize) {
            /* eslint-disable-next-line no-restricted-globals */
            if (!isNaN(this._width)) {
                this.canvas.width = this._width;
                delete this._width;
            }

            /* eslint-disable-next-line no-restricted-globals */
            if (!isNaN(this._height)) {
                this.canvas.height = this._height;
                delete this._height;
            }
            /* eslint-enable no-restricted-globals */

            this.canvases.forEach(canvas => {
                canvas.width = this.width;
                canvas.height = this.height;
            });

            this._updateSize = false;

            this.canvas.dispatchEvent(new Event('resize'));
            this.canvases.forEach(canvas => canvas.dispatchEvent(new Event('resize')));
        }
    }

    setFrameRate(frameRate) {
        // we could check against the settings currently found in
        // the stream, rather than the constraint we requested.
        // but if that constraint has resulted in a different setting,
        // there might not be any point in trying to request the
        // same constraint again.
        if (this.frameRate === frameRate) return;

        this.frameRate = frameRate;
        this.canvasStream.getVideoTracks()[0].applyConstraints({frameRate});

        if (this.isDrawing) this.startDrawing();
    }

    _fade(stream, fadeIn = true, period = 500) {
        const currentAspectRatio = this.aspectRatio;

        return new Promise((resolve, _reject) => {
            const videoInput = this.getInputByStream(stream);
            if (videoInput && !videoInput._fade) {
                videoInput._fade = true;

                const newAspectRatio = videoInput.aspectRatio;

                const now = Date.now();
                const intervalId = setInterval(() => {
                    let interpolation = (Date.now() - now) / period;
                    interpolation = Math.min(interpolation, 1);

                    /* eslint-disable-next-line no-restricted-globals */
                    if (fadeIn && !isNaN(newAspectRatio) && !isNaN(currentAspectRatio)) {
                        const aspectRatio = (newAspectRatio * interpolation) + (currentAspectRatio * (1 - interpolation));
                        this.aspectRatio = aspectRatio;
                    }

                    if (interpolation < 1) {
                        videoInput.alpha = fadeIn ?
                            interpolation :
                            1 - interpolation;
                    } else {
                        videoInput.alpha = fadeIn ? 1 : 0;
                        delete videoInput._fade;
                        clearInterval(intervalId);
                        resolve(stream);
                    }
                }, 1000 / this.frameRate);
            } else
                resolve(stream);
        });
    }
    fadeIn(stream, period) {
        return this._fade(stream, true, period);
    }
    fadeOut(stream, period) {
        return this._fade(stream, false, period);
    }

    close() {
        this.stopDrawing();
        this.inputs.forEach(input => input.remove());
        this.canvasStream.getVideoTracks()[0].stop();
        this.canvases.length = 0;
    }
}

class AgoraPeerManager {
    constructor(chatManager) {
        this.chatManager = chatManager;
        this.viewId = this.chatManager.viewId;

        // @@ long-lived temporary hack
        this.elements = this.chatManager.elements;

        this.peerDict = {}; // streams and flags by viewId (including local)
        // this.uidDict = {}; // {uid: viewId};

        this.ensurePeerState(this.viewId); // get it over with :)
        this.connectionState = 'DISCONNECTED';
        this.setUpConnectionPromise();

        this.appID = 'a4df6cd2da8445c393b56527eacf529a';
        this.setUpClient();
    }

    setUpConnectionPromise() {
        this.connectionP = new Promise(resolve => this.resolveConnectionPromise = resolve);
    }

    setUpClient() {
        this.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

        // insert our own try/catch into the handlers, because otherwise
        // Agora will silently swallow any error
        const addHandler = (eventName, handlerName) => {
            this.client.on(eventName, (...data) => {
                try {
                    this[handlerName](...data);
                } catch (e) { console.error(e); }
            });
        };

        // CONNECTING, CONNECTED, RECONNECTING (v4), DISCONNECTING, DISCONNECTED
        addHandler('connection-state-change', 'onConnectionStateChange'); // v4

        addHandler('user-published', 'onUserPublished'); // v4: sent to remote clients when a client publishes a video or audio track
        addHandler('user-unpublished', 'onUserUnpublished'); // v4: sent to remote clients when a client unpublishes a track
        addHandler('user-left', 'onUserLeft'); // sent to remote clients when a client leaves the room

        addHandler('stream-fallback', 'onStreamFallback');
        addHandler('join-fallback-to-proxy', 'onJoinFallbackToProxy'); // new in v4.9
        addHandler('user-info-updated', 'onUserInfoUpdated');

        addHandler('network-quality', 'onNetworkQuality');
        addHandler('exception', 'onException');

        addHandler('volume-indicator', 'onVolumeIndicator');
    }

    peerState(viewId) { return this.peerDict[viewId]; }
    ensurePeerState(viewId) {
        let state = this.peerDict[viewId];
        if (!state) {
            // for remote peers, videoDisabled and audioDisabled (which are used in
            // setting a peer's display style) reflect directly whether there are
            // null entries in mediaTracks (as updated by user-publish
            // and user-unpublish events).  for the local peer, the tracks live on
            // but are selectively enabled and disabled (which, once they've been
            // published, will trigger their being unpublished and republished)
            // under local user control.
            state = this.peerDict[viewId] = {
                published: false,
                audioTrack: null,
                audioDisabled: true,
                videoTrack: null,
                videoDisabled: true,
                lastAnnounce: Date.now(),
                left: false
            };
        }
        return state;
    }
    get localPeerState() { return this.peerState(this.viewId); }
    isKnownPeer(viewId) {
        const state = this.peerState(viewId);
        return !!(state && !state.left);
    }
    removePeerState(viewId) {
        delete this.peerDict[viewId];
    }
    setPeerLastAnnounce(viewId) {
        const state = this.ensurePeerState(viewId);
        state.lastAnnounce = Date.now();
    }
    getPeerIds() { return Object.keys(this.peerDict); }

    getPeerMedia(viewId, mediaType) {
        // if the view hasn't been heard of yet, return null
        const prop = `${mediaType}Track`;
        return this.peerState(viewId)?.[prop];
    }

    async setLocalAudio(nativeTrack) {
        const state = this.localPeerState;
        const { audioTrack, audioDisabled } = state;
        delete state.audioTrack;

        const newAudioTrack = await AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: nativeTrack });

        // iff the audio has been published and is currently unmuted, replace it
        if (audioTrack && !audioDisabled && audioTrack._croquetPublished) {
            await this.client.unpublish(audioTrack);
            await newAudioTrack.setMuted(false);
            newAudioTrack._croquetPublished = true;
            await this.client.publish(newAudioTrack);
            this.elements.ui.classList.add('published-tracks');
        }
        state.audioTrack = newAudioTrack;
        this.chatManager.onPeerMedia(this.viewId, 'audio', newAudioTrack);
    }

    async setLocalVideo(nativeTrack) {
        // this embodies the assumption that the video track is never replaced
        const state = this.localPeerState;
        const newVideoTrack = await AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: nativeTrack });
        state.videoTrack = newVideoTrack;
        this.chatManager.onPeerMedia(this.viewId, 'video', newVideoTrack);
    }

    registerPeerMedia(viewId, mediaType, track) {
        const state = this.ensurePeerState(viewId);
        state.published = true;
        const trackProp = `${mediaType}Track`;

        // if we got a new stream from the same peer, remove the old one.
        const knownTrack = state[trackProp];
        if (knownTrack && knownTrack !== track) this.chatManager.offPeerMedia(viewId, mediaType, knownTrack);

        state[trackProp] = track;
        state[`${mediaType}Disabled`] = false;
    }

    unregisterPeerMedia(viewId, mediaType) {
        const state = this.ensurePeerState(viewId);
        delete state[`${mediaType}Track`];
        state[`${mediaType}Disabled`] = true;
        state.published = ['audioTrack', 'videoTrack'].some(key => state[key]);
    }

    // LOCAL CHAT CONNECTION
    connect() {
        // invoked on clicking Join button when DISCONNECTED, or in chatManager.addPeer
        // when this is DISCONNECTED but still in the Croquet session
        if (this.connectionState === 'DISCONNECTED' && this.chatManager.numberOfPeers > 1) {
            // NB: the null arg is in place of a token, which Agora
            // supports for apps that need authentication of individual
            // clients.  i.e., we're using the "low security" approach.
            // https://docs.agora.io/en/Interactive%20Broadcast/API%20Reference/web/interfaces/agorartc.client.html#join
            // the channel-name arg can be up to 64 bytes.  most
            // punctuation is ok, but apparently not "/" or "\".

            // v4 events: https://docs.agora.io/en/Interactive%20Broadcast/API%20Reference/web_ng/interfaces/iagorartcclient.html?platform=Web
            this.client.join(this.appID, sessionConfiguration.channelName, null, this.viewId)
                .then(_uid => {
                    // the connection-state change has probably already arrived
// console.log("successful client.join()");
                    this.resolveConnectionPromise();
                }).catch((err) => console.error(err));
        }
    }
    disconnect() {
        // invoked from shutDown, or chatManager.removePeer
        // if total number of peers has dropped to 1.
        if (this.connectionState === 'CONNECTED' || this.connectionState === "CONNECTING") {
            this.client.leave()
                .then(() => console.log("left chat"))
                .catch(err => console.log(`Error on leaving chat: ${err.message}`));
        }
    }
    ensureConnected() {
        if (this.connectionState !== 'CONNECTED' && this.connectionState !== 'CONNECTING') {
            this.connect();
        }
    }
    ensureDisconnected() {
        if (this.connectionState !== 'DISCONNECTED' && this.connectionState !== 'DISCONNECTING') {
            this.disconnect();
        }
    }

    // v4
    onConnectionStateChange(curState, revState, reason) {
// console.log(`received connection state ${curState}`);
        this.connectionState = curState;
        let localState;
        switch (this.connectionState) {
            case 'DISCONNECTED':
                // v4: could at least log the reason
                this.elements.ui.classList.remove('connected');
                this.stopCheckingPeerState();
                // if this is a shutdown, local state will have been cleared
                localState = this.localPeerState;
                if (localState) {
                    // in case we're about to reconnect, leave in place the audio/video
                    // status (track, disabled state) but remove the tracks' published
                    // flag, so that on reconnection we'll publish again.
                    localState.published = false;
                    localState.left = true;
                    if (localState.audioTrack) delete localState.audioTrack._croquetPublished;
                    if (localState.videoTrack) delete localState.videoTrack._croquetPublished;
                    this.setUIForPublishState(localState.published);
                }
                this.chatManager.onChatDisconnected();
                this.setUpConnectionPromise();
                break;
            case 'CONNECTING':
            case 'RECONNECTING':
                // after join() is called, or during Agora's automatic reconnect
                // attempt when connection is temporarily lost
                break;
            case 'CONNECTED':
                this.elements.ui.classList.add('connected');
                localState = this.localPeerState;
                localState.left = false;
                // on first connection, these will have already been called.  but
                // the duplication doesn't matter, and we need to call from here
                // for reconnections.
                if (!localState.audioDisabled) this.ensureAudioMuteState(false);
                if (!localState.videoDisabled) this.ensureVideoMuteState(false);
                this.startCheckingPeerState();
                this.chatManager.onChatConnected();
                break;
            default:
                break;
        }
    }

    startCheckingPeerState() {
        this.stopCheckingPeerState();
        this._checkPeersIntervalId = window.setInterval(this.checkPeers.bind(this), 1000);
    }
    stopCheckingPeerState() {
        if (this._checkPeersIntervalId) {
            window.clearInterval(this._checkPeersIntervalId);
            delete this._checkPeersIntervalId;
        }
    }

    checkPeers() {
        this.getPeerIds().forEach(viewId => {
            // this is only to catch a peer that is not playing by
            // the normal rules (typically, a remnant caused by a
            // peer reloading with a different view id).  any peer
            // already recorded as having left, or that is currently
            // published, is not under suspicion.
            if (viewId === this.viewId) return;

            const state = this.peerDict[viewId];
            if (state.left || state.published) return;

            const seconds = Math.floor((Date.now() - state.lastAnnounce) / 1000);
            if (seconds >= 35) {
                console.warn(`${viewId} not heard from in ${seconds}s; assuming it has left chat`);
                state.left = true;
                // make the rest asynchronous
                Promise.resolve().then(() => {
                    this.cleanUpTracksForLeavingPeer(viewId);
                    this.chatManager.provisionallyRemovePeer(viewId);
                    });
            }
        });
    }

    async ensureAudioMuteState(muted) {
        // used to mute/unmute our audio in the call.
        // given the choice between setEnabled and setMuted, for audio we use the
        // latter because (according to API docs) it switches more quickly.
        // in v4, setMuted() automatically triggers publishing and unpublishing
        // of the track iff it's already been published.
        // wait on the connection promise to ensure the client is ready to publish.
        const localState = this.localPeerState;
        const { audioTrack, audioDisabled } = localState;
        if (audioDisabled !== muted) {
            localState.audioDisabled = muted;
            await audioTrack.setMuted(muted);
        }
        if (!muted && !audioTrack._croquetPublished) {
            await this.connectionP;
            if (localState.audioDisabled || localState.audioTrack._croquetPublished) return;

            audioTrack._croquetPublished = true;
            await this.client.publish(audioTrack);
console.log("own audio published");
        }
        // if audio is muted, our published state depends on the video track
        localState.published = !muted || !localState.videoDisabled;
        this.setUIForPublishState(localState.published);
    }

    async ensureVideoMuteState(disabled) {
        // used to mute/unmute our video in the call.
        // given the choice between setEnabled and setMuted, we use the former
        // because when enabled=false the camera light will be turned off, as
        // the user would expect.
        // in v4, setEnabled() automatically triggers publishing and unpublishing
        // of the track iff it's already been published.
        // @@ in v3 it was used on remote streams too, for temporarily suspending incoming video for peers we didn't want to display.  if that's helpful for CPU usage, we might need to figure out an equivalent mechanism.  see calls to ensurePeerVideoDisplayState.
        const localState = this.localPeerState;
        const { videoTrack, videoDisabled } = localState;
        if (videoDisabled !== disabled) {
            localState.videoDisabled = disabled;
            await videoTrack.setEnabled(!disabled);
        }
        if (!disabled && !videoTrack._croquetPublished) {
            await this.connectionP;
            if (localState.videoDisabled || localState.videoTrack._croquetPublished) return;

            videoTrack._croquetPublished = true;
            await this.client.publish(videoTrack);
console.log("own video published");
        }
        // if video is disabled, our published state depends on the audio track
        localState.published = !disabled || !localState.audioDisabled;
        this.setUIForPublishState(localState.published);
    }

    onClientRoleChanged(event) {
        console.log("onClientRoleChanged", event);
    }

    // REMOTE PEER STATE
    async onUserPublished(user, mediaType) {
console.log("onuserpublished", user, mediaType);
        const viewId = user.uid;
        this.chatManager.postponePeerCheck(viewId);
        const state = this.ensurePeerState(viewId);
        delete state.left; // in case the peer went and came back

        // make sure we don't have multiple subscribe attempts for same publish
        const timerProp = `${mediaType}SubscribeTimer`;
        if (state[timerProp]) {
            clearTimeout(state[timerProp]);
            delete state[timerProp];
        }

        // aug 2022 comment from Agora Support on connecting in the presence of network errors:
        // "when our SDK tries to subscribe remote user stream track, if a connection issue occurs which failed the subscription, our SDK won't automatically help re-subscribe remote users. In this case, in your code, you may add logic to check if the promise of API subscribe is null. You may call it again if yes."
        // practically speaking, during bad network conditions it looks like the promise
        // tends to just hang around - without being resolved or rejected - until either
        // the condition clears, or the client drops into automatic reconnection.
        const tryToSubscribe = async () => {
            let status, errMsg;
            try {
                status = await this.client.subscribe(user, mediaType);
            } catch (e) {
                errMsg = e.message;
            }
            if (status && !errMsg) {
                // there's a narrow window in which an unpublish immediately after
                // a publish will cause the client.subscribe call to (misleadingly)
                // succeed.  but the user object knows what's up.
                const track = user[`${mediaType}Track`];
                if (!track) {
                    console.warn(`subscribe: ${mediaType} track for ${viewId} disappeared while subscribing`);
                    return;
                }
                console.log(`subscribed to ${viewId}'s ${mediaType}`);
                this.registerPeerMedia(viewId, mediaType, track);
                this.chatManager.onPeerMedia(viewId, mediaType, track);
            } else {
                let msg = `will retry subscribe for ${viewId}'s ${mediaType}`;
                if (errMsg) msg += ` following error: ${errMsg}`;
                console.warn(msg);
                state[timerProp] = setTimeout(() => {
                    if (state.left || !state[timerProp]) return; // left or unpublished while we were waiting

                    delete state[timerProp];
                    tryToSubscribe();
                }, 2000);
                this.chatManager.publishTrackSubscriptions(); // so remote peer realises there's a problem
            }
        };
        tryToSubscribe();
    }

    async onUserUnpublished(user, mediaType) {
        // a remote user has unpublished one of its tracks (perhaps the last)
console.log("onuserunpublished", user, mediaType);

        const viewId = user.uid;
        this.chatManager.postponePeerCheck(viewId);
        const state = this.ensurePeerState(viewId);
        const timerProp = `${mediaType}SubscribeTimer`;
        if (state[timerProp]) {
            clearTimeout(state[timerProp]);
            delete state[timerProp];
        }

        // check that we knew of the track we'll supposedly be unsubscribing from
        const track = this.getPeerMedia(viewId, mediaType);
        if (!track) {
            console.warn(`unsubscribe: failed to find ${mediaType} track for ${viewId}`);
            this.chatManager.publishTrackSubscriptions(); // so remote peer knows the situation
            return;
        }

        try {
            await this.client.unsubscribe(user, mediaType);
            console.log(`unsubscribed from ${viewId}'s ${mediaType}`);
        } catch (e) {
            console.error(e);
        }

        // first unregister the track, so we can update the .published
        // state for offPeerMedia to access.
        this.unregisterPeerMedia(viewId, mediaType);
        this.chatManager.offPeerMedia(viewId, mediaType, track);
    }

    onUserLeft(user, reason) {
        // sent to remote peers when a peer leaves the room,
        // or its role changes from "host" to "audience".
        // in the latter case, the peer is still there; we
        // shouldn't remove its record.
        // reason is one of "Quit", "ServerTimeOut", "BecomeAudience"

        const viewId = user.uid;
console.log(`peer ${viewId} left: ${reason}`);

        const state = this.peerState(viewId);
        if (!state) {
            console.warn(`leaving ${viewId} record not found`);
            return;
        }

        this.cleanUpTracksForLeavingPeer(viewId);

        if (reason !== "BecomeAudience") {
            // no expectation that this peer will return
            // - but chatManager won't throw it out unless/until
            // the peer disappears from the Croquet session too.
            state.left = true;
            this.chatManager.provisionallyRemovePeer(viewId);
        }
    }

    cleanUpTracksForLeavingPeer(viewId, shutdown = false) {
        const state = this.peerDict[viewId];
        const { audioTrack, videoTrack } = state;
        if (audioTrack) this.chatManager.offPeerMedia(viewId, 'audio', audioTrack, shutdown);
        if (videoTrack) this.chatManager.offPeerMedia(viewId, 'video', videoTrack, shutdown);
        state.audioDisabled = state.videoDisabled = true;
        state.published = false;
    }

    setUIForPublishState(published) {
        if (published) this.elements.ui.classList.add('published-tracks');
        else this.elements.ui.classList.remove('published-tracks');
    }

    onStreamFallback(uid, direction) { console.warn(`stream-fallback (${direction} for user ${uid}`); }
    onJoinFallbackToProxy(server) { console.warn(`join-fallback-to-proxy ${server}`); }

    onUserInfoUpdated(...data) {
        console.log("user info updated", ...data);
    }

    onNetworkQuality(stats) {
        /* per https://docs.agora.io/en/Video/API%20Reference/web_ng/interfaces/networkquality.html, for each of uplink and downlink the number means:
            0: The quality is unknown.
            1: The quality is excellent.
            2: The quality is good, but the bitrate is less than optimal.
            3: Users experience slightly impaired communication.
            4: Users can communicate with each other, but not very smoothly.
            5: The quality is so poor that users can barely communicate.
            6: The network is disconnected and users cannot communicate.
        */
        const { uplinkNetworkQuality, downlinkNetworkQuality } = stats;
        if (uplinkNetworkQuality > 1 || downlinkNetworkQuality > 1) console.log(stats);
    }
    onException(event) {
        console.log(`Agora exception ${event.code} (${event.msg}) for ${event.uid}`);
    }

    shutDown() {
        this.stopCheckingPeerState();

        Object.keys(this.peerDict).forEach(viewId => {
            if (viewId !== this.viewId) this.cleanUpTracksForLeavingPeer(viewId);
            this.removePeerState(viewId);
        });

        this.disconnect();
    }
}

class LocalMediaManager {
    constructor(chatManager) {
        this.chatManager = chatManager;

        // @@ something of a hack
        this.elements = chatManager.elements;
        this.audioContext = chatManager.audioContext;

        this.userWantsAudio = chatManager.userWantsLocalAudio;
        this.userWantsVideo = chatManager.userWantsLocalVideo;
        this.localInputStreams = {}; // selected audio, selected video
        if (this.userWantsAudio) {
            // create a gain node that is always
            // connected to an analyser to measure level (even if the
            // stream to the call is muted), and to testAudioNode for
            // listening to one's own mic.
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 1;

            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 4096; // approx 85ms at 48k
            this.byteTimeDomainData = new Uint8Array(this.analyser.fftSize);
            this.gainNode.connect(this.analyser);

            this.testAudioNode = this.audioContext.createMediaStreamDestination();
            this.elements.localAudio.srcObject = this.testAudioNode.stream;
            this.gainNode.connect(this.testAudioNode);
            this.elements.localAudio.muted = true;

            // WAVEFORM
            // currently set to take 20 samples to display 0.5s,
            // requiring a sample every 25ms.
            const config = this.waveformConfiguration = {
                period: 0.5,
                sampleCount: 20,
                waveform: [],
            };
            config.sampleInterval = 1000 * config.period / config.sampleCount;
        }

        this.streamMixer = new StreamMixer(this);
    }

    // PEER INPUT STREAMS
    chatVideoSource() { return this.streamMixer.canvasStream.getVideoTracks()[0]; }

    async startMedia() {
        if (this.userWantsVideo) {
            this.chatVideoTrack = this.chatVideoSource(); // this never changes
            this.chatManager.localVideoStarted(this.chatVideoTrack);
            await this.updateVideoInputs();
        }

        if (this.userWantsAudio) {
            await this.updateAudioInputs();
            await this.setAudioInput(); // includes setting chatAudioTrack

            // on Safari (at least), the audioContext doesn't start
            // in 'running' state.  it seems we can start it here, now
            // we have the user permissions.
            // when audio is not available, we still need an audioContext
            // for measuring other peers' streams.  this check is carried
            // out in chatManager.frobPlayHooks.
            const audioContext = this.audioContext;
            if (audioContext.state !== 'running' && audioContext.state !== 'closed')
                audioContext.resume();

            this.startWaveform();
            this.startTestingAudioLevel();
        }

        this.mediaStarted = true;
    }

    stopStream(stream) {
        if (!stream) return;
        stream.getTracks().forEach(track => track.stop());
    }

    stopAudioStream() {
        if (this.localInputStreams.audio) {
            this.stopStream(this.localInputStreams.audio);
            delete this.localInputStreams.audio;
        }

        if (this.localInputStreams.mediaStreamSource) {
            this.localInputStreams.mediaStreamSource.disconnect();
            delete this.localInputStreams.mediaStreamSource;
        }
    }

    stopVideoStream() {
        if (this.localInputStreams.video) {
            this.stopStream(this.localInputStreams.video);
            delete this.localInputStreams.video;
        }
    }

    onDeviceChange() {
        // a device has come or gone.  update the selectors.
        // ...unless we're still in the process of initialising
        // the media for the first time.
        if (!this.mediaStarted) return;

        if (this.userWantsVideo) this.updateVideoInputs();
        if (this.userWantsAudio) this.updateAudioInputs();
    }


    // VIDEO

    updateVideoInputs() {
        // refresh the video-selection list with all available built-in devices
        if (this._updateVideoInputsPromise) return this._updateVideoInputsPromise;

        const previousSelection = this.elements.videoInputs.selectedOptions[0];
        const previousLabel = (previousSelection && previousSelection.label)
            || (this.localInputStreams.video && this.localInputStreams.video._label)
            || sessionConfiguration.cameraDeviceLabel;
        let lookingForPrevious = !!previousLabel;
        let firstOption;

        const videoInputs = this.elements.videoInputs;
        videoInputs.innerHTML = '';
        const videoPlaceholderOption = document.createElement('optgroup');
        videoPlaceholderOption.disabled = true;
        videoPlaceholderOption.selected = false;
        videoPlaceholderOption.label = "Select Camera";
        videoInputs.appendChild(videoPlaceholderOption);

        // v4
        const promise = this._updateVideoInputsPromise = AgoraRTC.getDevices()
            .then(devices => {
                devices.filter(device => device.kind === 'videoinput').forEach(device => {
                    const { deviceId, label } = device;

                    // re-apply any earlier selection
                    const selected = lookingForPrevious && previousLabel === label;
                    if (selected) lookingForPrevious = false;

                    // (text, value, defaultSelected, selected)
                    const option = new Option(label, deviceId, selected, selected);
                    if (!firstOption) firstOption = option;

                    videoInputs.appendChild(option);
                });

                // if previous selection has gone, select the first entry
                if (lookingForPrevious && firstOption) {
                    console.warn(`previous device "${previousLabel}" is gone; switching to "${firstOption.label}"`);
                    videoInputs.value = firstOption.value;
                    if (this.mediaStarted) this.setVideoInput();
                }
            }).catch(err => {
                console.error("error in updateVideoInputs", err);
            }).finally(() => {
                delete this._updateVideoInputsPromise;
            });

        return promise;
    }
    setVideoInput() {
        // NB: this only determines which input goes to the mixer.  the video track sent
        // to the Agora session is from the mixer's canvasStream.
        if (this._setVideoInputPromise) return this._setVideoInputPromise;

        const videoInputs = this.elements.videoInputs;
        const option = videoInputs.selectedOptions[0];
        const selectedId = option ? option.value : 'default';
        const selectedLabel = option ? option.label : '';

        const videoStream = this.localInputStreams.video;
        if (videoStream && videoStream._label === selectedLabel && videoStream.active) {
            console.log("video stream already matches selection");
            return Promise.resolve();
        }

        let currentStream = this.localInputStreams.video;
        if (currentStream && this.isMobile()) {
            // @@ what's special about mobile?
            this.stopStream(currentStream);
            this.streamMixer.removeStream(currentStream);
            delete this.localInputStreams.video;
            currentStream = null; // already dealt with
        }

        const promise = this._setVideoInputPromise = navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: selectedId,
                    frameRate: isBackdrop ? 30 : 12,
                    aspectRatio: 1.333,
                    width: 240,
                    height: 240 / 1.333,
                    resizeMode: "crop-and-scale",
                }
            }).then(stream => {
                this.localInputStreams.video = stream;

                const videoTrack = stream.getVideoTracks()[0];
                stream._label = videoTrack.label;
                videoTrack.onmute = () => {
                    console.log('video track muted itself');
                };
                videoTrack.onunmute = () => {
                    console.log('video track unmuted itself');
                };

                // if the system came back with a track that corresponds
                // to a different entry in the list, select that entry.
                const newOption = Array.from(videoInputs.options).find(opt => videoTrack.label === opt.label);
                if (newOption && newOption.value !== selectedId) {
                    console.warn(`system chose alternate option: "${newOption.label}" cf. requested "${selectedLabel}"`);
                    videoInputs.value = newOption.value;
                }

                // @@@ tighten this up.
                // Pixel has cameras with labels that (in English
                // locale, at least) include "facing front" or
                // "facing back".  but seems like a YMMV.
                // in principle, looks like we should be using facingMode
                // https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/facingMode
                this.isCameraFacingUser = !videoTrack.label.toLowerCase().includes('back');
                if (this.isCameraFacingUser)
                    this.elements.localVideoCanvas.dataset.isCameraFacingUser = this.isCameraFacingUser;
                else
                    delete this.elements.localVideoCanvas.dataset.isCameraFacingUser;

                const videoInput = this.streamMixer.addStream(stream);
                const onMetadata = () => {
                    this.streamMixer.fadeIn(stream);

                    if (currentStream) {
                        this.streamMixer.fadeOut(currentStream)
                        .then(() => {
                            this.streamMixer.removeStream(currentStream);
                            this.stopStream(currentStream);
                        });
                    }
                };
                // if the loadedmetadata event has already happened, run the handler immediately
                if (videoInput.video.loadedmetadata) onMetadata();
                else {
                    videoInput.video.addEventListener('loadedmetadata', onMetadata, { once: true });
                }

                this.elements.toggleVideo.classList.remove('error');
            }).catch(err => {
                console.log("error in setVideoInput", err);
                this.elements.toggleVideo.classList.add('error');
                // throw err;
            }).finally(() => {
                delete this._setVideoInputPromise;
            });

        return promise;
    }


    // AUDIO
    updateAudioInputs() {
        // refresh the audio-selection list with all available built-in devices
        if (this._updateAudioInputsPromise) return this._updateAudioInputsPromise;

        const previousSelection = this.elements.audioInputs.selectedOptions[0];
        const previousLabel = (previousSelection && previousSelection.label)
            || (this.chatAudioTrack && this.chatAudioTrack.label)
            || sessionConfiguration.micDeviceLabel;
        let lookingForPrevious = !!previousLabel;
        let firstOption;

        const audioInputs = this.elements.audioInputs;
        audioInputs.innerHTML = '';
        const audioPlaceholderOption = document.createElement('optgroup');
        audioPlaceholderOption.disabled = true;
        audioPlaceholderOption.selected = false;
        audioPlaceholderOption.label = "Select Microphone";
        audioInputs.appendChild(audioPlaceholderOption);

        const promise = this._updateAudioInputsPromise = AgoraRTC.getDevices()
            .then(devices => {
                devices.filter(device => device.kind === 'audioinput').forEach(device => {
                    const { deviceId, label } = device;

                    if (deviceId === 'default' || deviceId === 'communications') {
                        // console.log(`rejecting "default" device (${label})`);
                        return;
                    }

                    // re-apply any earlier selection
                    const selected = lookingForPrevious && previousLabel === label;
                    if (selected) lookingForPrevious = false;

                    // (text, value, defaultSelected, selected)
                    const option = new Option(label, deviceId, selected, selected);
                    if (!firstOption) firstOption = option;
                    audioInputs.appendChild(option);
                });

                // if previous selection has gone, select the first entry
                // and (if the chat stream is already running) force a
                // change to that device.
                if (lookingForPrevious && firstOption) {
                    console.warn(`previous device "${previousLabel}" is gone; switching to "${firstOption.label}"`);
                    audioInputs.value = firstOption.value;
                    if (this.mediaStarted) this.setAudioInput();
                }
            }).catch(err => {
                console.error("error in updateAudioInputs", err);
            }).finally(() => {
                delete this._updateAudioInputsPromise;
            });

        return promise;
    }

    setAudioInput(force) {
        if (this._setAudioInputPromise) return this._setAudioInputPromise;

        const audioInputs = this.elements.audioInputs;
        const option = audioInputs.selectedOptions[0];
        if (!option) {
            console.warn("no audio selections available");
            return Promise.resolve();
        }

        const selectedId = option.value;
        const selectedLabel = option.label;

        const currentAudioTrack = this.chatAudioTrack;
        if (!force && currentAudioTrack && currentAudioTrack.label === selectedLabel && currentAudioTrack.readyState === 'live') {
            console.log("audio stream already matches selection");
            return Promise.resolve();
        }

        // how audio input works:

        // from the stream for the selected audio-input device
        // we extract the audioTrack and pass it to Agora via
        // the AgoraPeerManager.  this is stored as chatAudioTrack.
        // from a clone of the stream we make a mediaStreamSource
        // (stored as this.localInputStreams.mediaStreamSource),
        // which is connected to the gainNode that was set up on
        // initialisation.  the gainNode is connected to a
        // mediaStreamDestination node for local feedback testing
        // (this.testAudioNode), and to an analyser for measuring
        // local audio level.

        // switching input device therefore involves
        //   - requesting a stream from the specified device
        //   - stopping the stream (if any) supplying local feedback
        //   - making a mediaStreamSource from a clone of the new stream
        //   - connecting the mediaStreamSource to the long-lived gainNode

        // jan 2021: avoid re-running getUserMedia on iPad, because there
        // is only ever one audio input device, and a repeated getUserMedia
        // causes the device to be somehow silenced (though not obviously
        // muted, disabled, or ended).

        // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
        let startPromise;
        const isIPad = navigator.userAgent.match(/\biPad\b/);
        const okToReplace = !isIPad || !this.chatAudioStream;
        if (!okToReplace) {
            console.log(`not invoking getUserMedia`);
            startPromise = Promise.resolve(this.chatAudioStream);
        } else {
            console.log(`getUserMedia with device ID "${selectedId}"`);
            startPromise = navigator.mediaDevices.getUserMedia({ audio: { deviceId: selectedId } });
        }
        const promise = this._setAudioInputPromise = startPromise
            .then(stream => {
                const chatAudioTrack = stream.getAudioTracks()[0];
                const prevAudioTrack = this.chatAudioTrack;
                if (!force && chatAudioTrack === prevAudioTrack) {
                    console.warn(`same audio track found; no replacement needed`);
                    return;
                }

                this.chatAudioStream = stream;
                this.chatAudioTrack = chatAudioTrack;
                chatAudioTrack.onmute = () => {
                    console.log('audio track muted itself');
                };
                chatAudioTrack.onunmute = () => {
                    console.log('audio track unmuted itself');
                };
                chatAudioTrack.onended = _event => {
                    // if the track unexpectedly ends, it probably means
                    // that something in the host's audio settings has
                    // been changed or replaced.  force a refresh of
                    // the audio input.
                    console.warn("audio track ended");
                    this.setAudioInput(true); // force re-init
                };

                // clone the stream (and its tracks) before using its track to
                // create an Agora audio track.
                const audioStreamClone = stream.clone();

                // replace the cloned stream that feeds the
                // level meter and the feedback test
                this.stopAudioStream(); // also disconnects mediaStreamSource, if any
                this.localInputStreams.audio = audioStreamClone;
                const mediaStreamSource = this.audioContext.createMediaStreamSource(audioStreamClone);
                mediaStreamSource.connect(this.gainNode);
                this.localInputStreams.mediaStreamSource = mediaStreamSource;
                audioStreamClone.getAudioTracks()[0].onended = () => console.log(`local subsidiary audio track ended unexpectedly`);

                this.chatManager.localAudioSelected(chatAudioTrack); // async
                this.elements.toggleAudio.classList.remove('error');
            }).catch(err => {
                console.warn(`setAudioInput failed for id ${selectedId}: ${err}`);
                this.elements.toggleAudio.classList.add('error');
            }).finally(() => {
                delete this._setAudioInputPromise;
            });

        return promise;
    }

    getAudioLevel(maxAge) {
        const audioTrack = this.chatAudioTrack; // native
        return audioTrack && audioTrack.getAudioLevel ? audioTrack.getAudioLevel(maxAge) : 0;
    }

    // WAVEFORM OVERLAID ON OUTGOING VIDEO
    isWaveformNeeded() {
        return !this.chatManager.chatAudioMuted && !this.chatManager.chatVideoMuted;
    }
    startWaveform() {
        this.stopWaveform();
        const config = this.waveformConfiguration;
        config.intervalId = window.setInterval(this.updateWaveform.bind(this), config.sampleInterval);
    }
    updateWaveform() {
        if (!this.isWaveformNeeded()) return;

        const config = this.waveformConfiguration;
        const audioLevel = this.getAudioLevel(config.sampleInterval / 2); // grab existing measurement if recent enough
        config.waveform.push(audioLevel);
        if (config.waveform.length > config.sampleCount)
            config.waveform.shift();
    }
    stopWaveform() {
        const config = this.waveformConfiguration;
        if (config.intervalId) {
            config.waveform.fill(0);
            window.clearInterval(config.intervalId);
            delete config.intervalId;
        }
    }
    drawWaveform(canvas) {
        if (!this.isWaveformNeeded()) return;

        const config = this.waveformConfiguration;
        const waveform = config.waveform;

        const context = canvas.getContext('2d');
        context.save();

        context.fillStyle = sessionConfiguration.viewColor;

        // YO's updated format, imported from video-chat/qchat-app.js
        const canvWidth = canvas.width;
        const canvHeight = canvas.height;

        const targetCenterX = canvWidth * 0.75;
        const targetCenterY = canvHeight * (1 - 0.2);
        const targetWidth = canvWidth / 3;
        const targetHeight = canvHeight * 0.15;

        const sampleWidth = targetWidth / waveform.length / 2;

        waveform.forEach((sample, sampleIndex) => {
            if (sample < 0.02) return; // don't plot negligible values

            const interpolation = (sampleIndex + 1) / waveform.length;

            const sampleHeight = sample * targetHeight * interpolation;
            const sampleX = targetWidth * (1 - interpolation) / 2;
            const sampleY = sampleHeight / 2;

            context.globalAlpha = interpolation;

            if (interpolation === 1) {
                context.fillRect(targetCenterX - sampleWidth, targetCenterY - sampleY, sampleWidth * 2, sampleHeight);
            } else {
                context.fillRect(targetCenterX - sampleX, targetCenterY - sampleY, sampleWidth, sampleHeight);
                context.fillRect(targetCenterX + sampleX, targetCenterY - sampleY, sampleWidth, sampleHeight);
            }
        });
        context.restore();
    }

    startTestingAudioLevel() {
        // this.docVisibility = document.visibilityState; // see check in testAudioLevel

        this._testAudioInterval = 100;
        this._testAudioLevelIntervalId = window.setInterval(this.testAudioLevel.bind(this), this._testAudioInterval);
    }
    testAudioLevel() {
        // if the document has been hidden then made visible again,
        // it used to be the case that at least Safari would have
        // interrupted audio on hide, and not restored it on unhide.
        // as of the jun 2022 v4 rewrite, audio restoration on unhide
        // does appear to happen even on Safari (MacOS, iOS).
        // commenting this out for now.
        // const vis = document.visibilityState;
        // if (vis !== this.docVisibility) {
        //     console.log(`document.visibilityState: ${vis}`);
        //     this.docVisibility = vis;
        //     if (vis === 'visible') {
        //         this.setAudioInput(true); // true => force
        //         return; // that's enough for this loop
        //     }
        // }

        const audioLevel = this.getLocalAudioLevel();

        // no need to display audio level if the meter isn't on view.
        if (this.elements.ui.classList.contains('hide-settings') || !this.localInputStreams.audio) return;

        if (this._maxAudioLevelLongTerm === undefined || audioLevel > this._maxAudioLevelLongTerm) {
            this._maxAudioLevelLongTerm = audioLevel;
            window.clearTimeout(this._maxAudioLevelLongTermTimeoutId);
            this._maxAudioLevelLongTermTimeoutId = window.setTimeout(() => {
                delete this._maxAudioLevelLongTerm;
                delete this._maxAudioLevelLongTermTimeoutId;

                this.elements.loudnessMax.style.bottom = '';
                this.elements.loudnessMax.style.left = '';
                }, 1500);

            const { flexDirection } = getComputedStyle(this.elements.loudnessBar);
            if (flexDirection.includes('row')) {
                this.elements.loudnessMax.style.left = `${94 * audioLevel}%`;
                this.elements.loudnessMax.style.bottom = '-3px';
            } else {
                this.elements.loudnessMax.style.left = '-1px';
                this.elements.loudnessMax.style.bottom = `${94 * audioLevel}%`;
            }
        }

        if (this._maxAudioLevelShortTerm === undefined || audioLevel > this._maxAudioLevelShortTerm) {
            this._maxAudioLevelShortTerm = audioLevel;
            window.clearTimeout(this._maxAudioLevelShortTermTimeoutId);
            this._maxAudioLevelShortTermTimeoutId = window.setTimeout(() => {
                delete this._maxAudioLevelShortTerm;
                delete this._maxAudioLevelShortTermTimeoutId;

                this.elements.loudnessValue.style.flex = 0;
                this.elements.loudnessValue.style.backgroundColor = 'green';
            }, 100);

            this.elements.loudnessValue.style.flex = audioLevel;

            const color = `hsl(${120 * (1 - (audioLevel ** 2))}, 100%, 50%)`;

            this.elements.loudnessValue.style.backgroundColor = color;
        }
    }
    stopTestingAudioLevel() {
        if (this._testAudioLevelIntervalId) {
            window.clearInterval(this._testAudioLevelIntervalId);
            delete this._testAudioLevelIntervalId;
        }
    }
    getLocalAudioLevel() {
        const data = this.byteTimeDomainData;
        this.analyser.getByteTimeDomainData(data);
        // for efficiency, don't examine every sampled value.
        // examining one in 19 implies an inter-measurement
        // interval of 1000/(48000/19), approx 0.4ms.
        const numSamples = this.analyser.fftSize;
        let value, max = 0;
        for (let i = 0; i < numSamples; i += 19) {
            value = data[i];
            value = Math.abs(value - 128);
            max = Math.max(max, value);
        }
        max /= 128;
        return max;
    }

    isMobile() { return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent); }

    get canCaptureAudioStream() { return HTMLAudioElement.prototype.captureStream; }

    // Local Video Settings
    get frameRate() { return this.streamMixer.frameRate; }
    set frameRate(frameRate) {
        this.streamMixer.setFrameRate(frameRate);
    }

    get width() { return this.streamMixer.width; }
    set width(width) { this.streamMixer.width = width; }

    get height() { return this.streamMixer.height; }
    set height(height) { this.streamMixer.height = height; }

    get compositingCanvas() { return this.streamMixer.canvas; }
    addOutputCanvas(canvas) { this.streamMixer.addOutputCanvas(canvas); }
    removeOutputCanvas(canvas) { this.streamMixer.removeOutputCanvas(canvas); }

    // VIDEO STREAM EVENTS
    onStreamAccessAllowed(_event, _stream) { }
    onStreamAccessDenied(_event, _stream) { }

    onStreamStopScreenSharing(_event, _stream) { }

    onStreamVideoTrackEnded(_event, _stream) { }
    onStreamAudioTrackEnded(_event, _stream) { }

    onStreamPlayerStatusChange(_event, _stream) { }

    shutDown() {
        // sent on voluntary session leave
        if (this.userWantsAudio) {
            this.stopWaveform();
            this.stopTestingAudioLevel();
        }
        // this.audioContext.close(); // no - we now reuse the global one
        this.streamMixer.close();
    }
}

class ChatManager {
    constructor(viewId) {
        this.viewId = viewId;
        this.isCroquetOffline = false;
        this.deferredCroquetEvents = [];
        this.peerChecks = {};
        this.croquetPeerState = {}; // state from Croquet
        this.subscribedPeers = {}; // viewId => ["a", "v"]
        this.solo = false;
        this.activePeer = null;
        this.playHooks = []; // list of functions for starting stalled media streams on user click
        this.payAttentionToIntendedStates = false;

        this.initializeUI();
        this.initializeCall();

window.chatManager = this;
    }

    initializeUI() {
        // ELEMENTS
        // ...many of which will be null, if isVideoAllowed is false
        this.elements = {
            ui: document.getElementById('ui'),

            toggleAudio: document.getElementById('toggleAudio'),
            toggleVideo: document.getElementById('toggleVideo'),

            localAudio: document.querySelector(`#local > audio`),

            toggleSolo: document.getElementById('toggleSolo'),
            toggleMicrophoneTest: document.getElementById('toggleMicrophoneTest'),

            videoInputs: document.getElementById('videoInputs'),
            audioInputs: document.getElementById('audioInputs'),

            loudness: document.querySelector('#loudness'),
            loudnessBar: document.querySelector('#loudness .bar'),
            loudnessMax: document.querySelector('#loudness .max'),
            loudnessValue: document.querySelector('#loudness .value'),

            activePeer: document.getElementById('activePeer'),
            activePeerVideo: document.querySelector('#activePeer video.video'),
            // activePeerMutePeer: document.querySelector('#activePeer .mutePeer'),
            localVideoCanvas: document.querySelector('#localVideoCanvas'),

            peersRaisingHands: document.querySelector('#peersRaisingHands'),
            peerRaisingHandTemplate: document.querySelector('#peerRaisingHandTemplate'),

            peers: document.getElementById('peers'),
            peerTemplate: document.getElementById('peerTemplate'),

            toggleHand: document.getElementById('toggleHand'),
        };

        // EVENTLISTENERS
        this.addEventListener(document, 'wheel', this.onWheel, {passive: false});
        this.addEventListener(this.elements.toggleAudio, 'click', this.onToggleAudioClick);
        // this.addEventListener(this.elements.toggleAudio, 'mouseover', this.showAudioTooltip);
        this.addEventListener(this.elements.toggleMicrophoneTest, 'click', this.onToggleMicrophoneTestClick);

        this.userWantsLocalAudio = sessionConfiguration.mic !== 'unavailable';
        if (!this.userWantsLocalAudio) this.elements.toggleAudio.classList.add('error');

        this.userWantsLocalVideo = sessionConfiguration.video !== 'unavailable';

        if (isVideoAllowed) {
            this.addEventListener(document, 'mousedown', this.onMouseDown);
            this.addEventListener(document, 'mousemove', this.onMouseMove);
            this.addEventListener(document, 'mouseup', this.onMouseUp);
            this.addEventListener(this.elements.toggleVideo, 'click', this.onToggleVideoClick);
            // this.addEventListener(this.elements.toggleVideo, 'mouseover', this.showVideoTooltip);
            this.addEventListener(this.elements.toggleSolo, 'click', this.onToggleSoloClick);
            // this.addEventListener(this.elements.activePeer, 'click', this.onActivePeerClick);
            this.addEventListener(this.elements.videoInputs, 'input', this.onVideoInput);

            if (!this.userWantsLocalVideo) this.elements.toggleVideo.classList.add('error');

            // ACTIVE PEER
            this.addEventListener(this.elements.activePeerVideo, 'play', this.updateActivePeerContainerStyle); // once the stream is playing, figure out its size
            this.addEventListener(this.elements.activePeerVideo, 'resize', this.updateActivePeerContainerStyle); // watch for changes in size, e.g. on auto-rotate of a mobile device
            // this.addEventListener(this.elements.activePeerMutePeer, 'click', () => this.mutePeer(this.getDisplayedActivePeer()));
            this.addEventListener(this.elements.activePeer, 'click', this.onPeerContainerClick);

            // RAISE HAND
            this.addEventListener(this.elements.toggleHand, 'click', this.onToggleHandClick);

            // RESIZE OBSERVER
            if (window.ResizeObserver) {
                this.resizeObserverConfiguration = { delay: 100, timestamp: Date.now() };
                this.resizeObserver = new ResizeObserver(this.resizeObserverCallback.bind(this));
                this.resizeObserver.observe(this.elements.activePeer);
                this.resizeObserver.observe(this.elements.peers);
            } else {
                console.warn("no ResizeObserver; reverting to listener");
                this.resizeConfiguration = { delay: 100, timestamp: Date.now(), timeoutId: undefined };
                this.addEventListener(window, 'resize', this.onResize);
            }

        }

        // MEDIA INPUT SELECTION
        this.addEventListener(navigator.mediaDevices, 'devicechange', this.ondevicechange);

        this.addEventListener(this.elements.audioInputs, 'input', this.onAudioInput);

        // if running on a device that can change orientation, hook
        // into that.
        this.addEventListener(window, 'orientationchange', this.onOrientationChange);

        // every click anywhere in the app is used to attempt to
        // release any blocks that have been registered by calls to
        // playBlocked()
        this.addEventListener(document, 'click', this.frobPlayHooks);

        this.audioContext = mainAudioContext;
    }

    async initializeCall() {
        // @@ NB: asking for the stream to have video and audio will
        // cause Safari (at least) to ask the user for permission
        // to access mic and camera - which a user who on the
        // landing page asked for both of them to be off will
        // presumably find surprising.
        // but it's easier to get it over with, in case the user
        // wants to send media later.
        this.chatPeerManager = new AgoraPeerManager(this);
        this.localMediaManager = new LocalMediaManager(this);

        this.startLocalMedia();
    }

    setQChatView(viewOrNull) {
        this.qChatView = viewOrNull;
        const isOffline = this.isCroquetOffline = !viewOrNull;
        if (isOffline) {
            this.elements.ui.classList.add('croquet-offline');
        } else {
            this.elements.ui.classList.remove('croquet-offline');

            // if there is already a record for the local view, this
            // must be a reconnection
            if (this.isLocalPeerKnown) {
                console.log("local view already registered in chat manager");
                this.publishTrackSubscriptions();

                // send any events that have been held back
                if (this.deferredCroquetEvents.length) {
                    this.deferredCroquetEvents.forEach(([event, data]) => {
                        this.publishToSession(event, data);
                    });
                    this.deferredCroquetEvents.length = 0;
                }
            }
        }
    }

    publishTrackSubscriptions() {
        this.publishToSession('peer-track-subscriptions', { viewId: this.viewId, subscribed: this.subscribedPeers });
    }

    publishToSession(event, data) {
        if (this.isCroquetOffline) {
            this.deferredCroquetEvents.push([event, data]);
            return;
        }

        this.qChatView.publish(this.qChatView.sessionId, event, data);
    }

    setPeerStateFromModel(viewId, peerSnap) {
        // sent from setKnownPeers (when joining or rejoining a session)
        // and directly from onPeerDetails when a single new peer arrives.
        // it's the opportunity to record - or to refresh - all details that
        // the model currently has, including those that henceforth we'll
        // be hearing about through published events.

        // because we need to refer to peer details frequently - for example,
        // when the active peer changes - and because we want to be largely
        // independent from the Croquet model, ChatManager maintains a
        // copy of most state.  this includes the defining properties for
        // each peer:
        //   peerIndex, nickname, initials, viewColor, agent (user-agent string)
        // and also the ephemeral properties:
        //   raisingHand, subscribed, offline (although: raisingHand & offline are absent if false, and for remote views (only) we store just whether the remote is subscribed to this view)

        // note that the model ensures that the supplied state is a deep clone
        // of the model's record, so we can store and update it at will.
        // also that there is an object value for subscribed, even if not
        // yet in the model.
        console.log(`setPeerStateFromModel ${viewId}`, {...peerSnap});
        const { subscribed, ...peerState } = peerSnap;
        if (viewId !== this.viewId && subscribed[this.viewId]) {
            peerState.subscriptionsToHere = subscribed[this.viewId];
        }
        const wasKnown = this.isPeerKnown(viewId);
        this.croquetPeerState[viewId] = peerState; // implicitly removes .offline, if there
        if (!wasKnown) {
            this.addPeer(viewId, peerState); // adds and styles peer container, sends onPeerHand, can trigger connection to chat
        } else if (isVideoAllowed) {
            this.updatePeerDefiningProperties(viewId);
            this.onPeerHand({ viewId, raisingHand: peerState.raisingHand }); // includes updatePeerEphemeralProperties
        }

        if (isVideoAllowed && viewId === this.viewId) {
            const uiClasses = this.elements.ui.classList;
            if (peerState.raisingHand) uiClasses.add('raisingHand');
            else uiClasses.remove('raisingHand');

            const localMuteImage = document.querySelector('#localMuteImage');
            localMuteImage.style.backgroundColor = peerState.viewColor;
        }
    }

    async startLocalMedia() {
        // this used to be sent once the AgoraPeerManager had created the stream that
        // would carry this client's media, having asked for camera and mic permissions.
        // in v4 there is no such stream, so we start the media tracks immediately.
console.warn(`starting local media as ${this.viewId}; mic=${sessionConfiguration.mic} video=${sessionConfiguration.video}`);

        this.elements.ui.classList.remove('published-tracks');

        // LocalMediaManager starts and maintains (non-Agora) audio and video tracks,
        // according to what devices the user has given permission for and chosen.
        // we pass those tracks to the AgoraPeerManager, at first without requesting
        // they be published.  when audio or video is first unmuted, the APM will note
        // that the corresponding Agora track has yet to be published and will do so.
        // thereafter, muting and unmuting will be handled by the APM by setting track
        // state which - allegedly - will automatically unpublish and republish the
        // track as needed.
        // replacement of a track to switch to a new device - which is only needed for
        // audio, since video is taken from a canvas that never changes even if the
        // selected camera does - requires passing the new track to the APM, which
        // will unpublish any existing track and (if already unmuted) publishing the
        // new one.

        const mediaMgr = this.localMediaManager;
        await mediaMgr.startMedia();

        const audioTrack = mediaMgr.chatAudioTrack;
        if (audioTrack) {
            if ((sessionConfiguration.micSettingInChat || sessionConfiguration.mic) === 'on') this.unmuteChatAudio();
            else this.muteChatAudio();
        } else this.chatAudioMuted = "unavailable";

        const videoTrack = mediaMgr.chatVideoTrack;
        if (videoTrack) {
            if ((sessionConfiguration.videoSettingInChat || sessionConfiguration.video) === 'on') this.unmuteChatVideo();
            else this.muteChatVideo(true); // stop stream (so the camera light goes off)
        } else this.chatVideoMuted = "unavailable";

        if (isVideoAllowed) this.startRenderingPeerBorders();
    }

    async localAudioSelected(audioTrack) {
        // ask the AgoraPeerManager to embed the selected track into an Agora track,
        // replacing (and unpublishing, if necessary) any existing track and invoking
        // onPeerMedia to add the audio-level helper.
console.warn("local audio set", audioTrack);
        await this.chatPeerManager.setLocalAudio(audioTrack);
    }

    async localVideoStarted(videoTrack) {
console.warn("local video started", videoTrack);
        await this.chatPeerManager.setLocalVideo(videoTrack);
    }

    onChatConnected() {
        // when this peer successfully joins (or re-joins) the Agora chat.
        // allow a few seconds for things to settle.
        setTimeout(() => {
            if (isVideoAllowed) this.startPollingForActivePeer();
            this.startAnnouncingStreamState();
            this.payAttentionToIntendedStates = true;
            }, 5000);
    }

    onChatDisconnected() {
        // when this peer leaves the Agora chat
        this.payAttentionToIntendedStates = false;
        this.stopPollingForActivePeer();
        this.stopAnnouncingStreamState();
    }

    getDisplayedActivePeer() { return this.elements.activePeer.dataset.viewId || null; }
    doWithRelevantContainers(viewId, fn) {
        if (this.isDisplayedActivePeer(viewId)) fn(this.elements.activePeer);

        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) fn(peerContainer);
    }
    isDisplayedActivePeer(viewId) { return viewId === this.getDisplayedActivePeer(); }

    onOrientationChange() { this.checkLocalVideoSize(); }

    checkLocalVideoSize() {
        if (!isVideoAllowed) return;

        setTimeout(() => this.doWithRelevantContainers(this.viewId, container => this.updatePeerContainerStyle(container)), 1000);
    }

    addSubscribedPeer(viewId, mediaType) {
        const localSubscribed = this.subscribedPeers;
        const abbrev = mediaType.slice(0, 1);
        let record = localSubscribed[viewId];
        if (!record) record = localSubscribed[viewId] = [];
        if (!record.includes(abbrev)) {
            record.push(abbrev);

            if (!this.isCroquetOffline) this.publishTrackSubscriptions();
        }
    }

    onPeerMedia(viewId, mediaType, agoraTrack) {
        // sent from startLocalMedia,
        // and from AgoraPeerManager.onUserPublished when the local client
        // subscribes to a remote track.
        // for an audio track, we set up the audio-level helper and start playing.
        // for a video track, we install it in the appropriate DOM container.

        // the Agora track is either local or remote; its embedded MediaStreamTrack
        // is accessible as agoraTrack.getMediaStreamTrack()
// console.log("onpeermedia", viewId, mediaType, agoraTrack, `known = ${this.isKnownChatPeer(viewId)}`);

        // if it's a remote peer, make a record of our being
        // subscribed, and announce that (if we're not offline).
        if (viewId !== this.viewId) this.addSubscribedPeer(viewId, mediaType);

        if (mediaType === 'audio') {
            // create a helper for measuring the audio level on
            // the track.
            // on the local track this is used to generate the waveform
            // that's superimposed on the outgoing video.
            // for remote peers it is used when the peer is unmuted
            // but hidden, to generate the flashing peer border.
            const track = agoraTrack.getMediaStreamTrack();
// console.warn("adding helper to track", track);
            if (!track._croquetAudioHelper) {
                track._croquetAudioHelper = {
                    audioContext: this.audioContext,
                    destroy() {
                        if (this._destroy) return;

                        if (this.mediaStreamSource) this.mediaStreamSource.disconnect();
                        if (this.analyser) this.analyser.disconnect();

                        this._destroy = true;
                    },
                    getMediaStreamSource() {
                        // invoked on every call to track.getAudioLevel.
                        // make sure there is a mediaStreamSource (once
                        // the stream has an audio track).
                        if (this._destroy) return undefined;

                        const audioContext = this.audioContext;

                        // if the mSS exists but its audio track has disappeared
                        // or has ended, remove it.  a new mSS will be created
                        // if a new audio track turns up.
                        let mss = this.mediaStreamSource;
                        const mssAudio = mss && mss.mediaStream.getAudioTracks()[0];
                        if (mss && (!mssAudio || mssAudio.readyState === 'ended')) {
                            mss.disconnect();
                            delete this.mediaStreamSource;
                            mss = null; // drop through
                        }

                        if (!mss && track.readyState === 'live') {
                            if (!this.analyser) {
                                this.analyser = audioContext.createAnalyser();
                                this.analyser.fftSize = 4096; // approx 85ms at 48k
                                this.byteTimeDomainData = new Uint8Array(this.analyser.fftSize);
                            }
                            const stream = new MediaStream();
                            stream.addTrack(track);
                            this.mediaStreamSource = audioContext.createMediaStreamSource(stream);
                            this.mediaStreamSource.connect(this.analyser);
                        }

                        return this.mediaStreamSource;
                    },
                    getAudioLevel(maxAge) {
                        // maxAge is an optional argument, to accept
                        // a previously measured level if it was taken
                        // no more than maxAge ms ago.
                        if (maxAge && this.lastLevelTime && Date.now() - this.lastLevelTime <= maxAge) return this.lastLevel;

                        let level = 0;
                        if (this.getMediaStreamSource()) {
                            const data = this.byteTimeDomainData;
                            this.analyser.getByteTimeDomainData(data);
                            // for efficiency, don't examine every sampled value.
                            // examining one in 19 implies an inter-measurement
                            // interval of 1000/(48000/19), approx 0.4ms.
                            const numSamples = this.analyser.fftSize;
                            let value, max = 0;
                            for (let i = 0; i < numSamples; i += 19) {
                                value = data[i];
                                value = Math.abs(value - 128);
                                max = Math.max(max, value);
                            }
                            max /= 128;
                            level = max;
                        }
                        this.lastLevel = level;
                        this.lastLevelTime = Date.now();
                        return level;
                    }
                };

                track.getAudioLevel = function(maxAge) {
                    return this._croquetAudioHelper.getAudioLevel(maxAge);
                    };
                track.getAudioLevel();
            }

            this.attachPeerAudio(viewId, agoraTrack);
        } else {
            // must be video

            // if view is in solo mode and the newly arriving peer isn't on
            // display, make sure its video display is hidden
            // (v4) not sure this is needed.  try without.
            // if (this.solo && viewId !== this.viewId && !this.isDisplayedActivePeer(viewId)) {
            //     this.ensurePeerVideoDisplayState(viewId, false);
            // }

            this.attachPeerVideo(viewId, agoraTrack);
        }
    }

    offPeerMedia(viewId, mediaType, agoraTrack, shutdown = false) {
        // a peer's media track has gone away.
        // sent from onUserUnpublished, chatPeerManager.cleanUpTracksForLeavingPeer
        // (which is invoked on peer exit and on shutdown)

        if (!agoraTrack || agoraTrack._croquetDestroyed) {
            console.log(`already removed ${mediaType} track for ${viewId}`);
            return;
        }
        agoraTrack._croquetDestroyed = true;

        if (mediaType === 'audio') {
            const track = agoraTrack.getMediaStreamTrack();
            if (track._croquetAudioHelper) track._croquetAudioHelper.destroy();
            this.removePeerAudio(viewId);
        } else {
            // remove the element that was handling video for the track
            this.removePeerVideo(viewId);
        }

        if (shutdown) return; // nothing more to do

        // if it's a remote peer, make note
        // of and announce (if we're not offline) our being unsubscribed
        if (viewId !== this.viewId) {
            const localSubscribed = this.subscribedPeers;
            const abbrev = mediaType.slice(0, 1);
            const record = localSubscribed[viewId];
            if (record && record.includes(abbrev)) {
                record.splice(record.indexOf(abbrev), 1);
                if (record.length === 0) delete localSubscribed[viewId];
                if (!this.isCroquetOffline) this.publishTrackSubscriptions();
            }
        }
    }

    onPeerHand({ viewId, raisingHand }) {
        if (!this.isPeerKnown(viewId)) return; // can happen if peer leaves before fully joining

        const peerState = this.croquetPeerState[viewId];
        if (raisingHand) {
            peerState.raisingHand = true;

            const { initials, viewColor } = peerState;
            const handContainer = this.elements.peerRaisingHandTemplate.content.cloneNode(true).querySelector('.peerRaisingHand');
            handContainer.dataset.viewId = viewId;
            handContainer.innerText = initials;
            handContainer.style.color = viewColor;
            this.elements.peersRaisingHands.appendChild(handContainer);

            this.elements.peersRaisingHands.classList.add('someHands');
        } else {
            delete peerState.raisingHand;

            document.querySelectorAll(`#peersRaisingHands .peerRaisingHand[data-view-id="${viewId}"]`).forEach(handContainer => handContainer.remove());

            if (this.filteredPeerIds(peer => peer.raisingHand).length === 0)
                this.elements.peersRaisingHands.classList.remove('someHands');
        }

        this.updatePeerEphemeralProperties(viewId);
    }

    playBlocked(unblocker, showWarning = true) {
        // when play() fails on a media element, add a warning that
        // the user needs to click to get things moving
        if (showWarning) this.elements.ui.classList.add('play-blocked');
        this.playHooks.push(unblocker);
    }
    frobPlayHooks() {
        resumeAudioContextIfNeeded();

        // only proceed if there are added hooks
        if (!this.playHooks.length) return;

        this.elements.ui.classList.remove('play-blocked'); // assume everything's going to be cleared.  hooks that fail will be added to the list again.

        const hooksClone = this.playHooks.slice();
        this.playHooks.length = 0;
        hooksClone.forEach(fn => {
            fn()
            .then(() => console.log(`play hook cleared`))
            .catch(err => {
                console.error(`play failed again`, err);
                this.playHooks.push(fn);
                this.elements.ui.classList.add('play-blocked');
                });
        });
    }

    onToggleHandClick(_event) {
        if (!this.isLocalPeerKnown) return;

        const uiClasses = this.elements.ui.classList;
        const raisingHand = !uiClasses.contains('raisingHand');
        if (raisingHand) uiClasses.add('raisingHand');
        else uiClasses.remove('raisingHand');

        this.publishToSession('peer-hand', { viewId: this.viewId, raisingHand });
    }

    onPeerContainerClick(event) {
        const viewId = event.currentTarget.dataset.viewId;
        const peerState = viewId && this.peerCombinedState(viewId);
        if (peerState) {
            const { nickname, agent } = peerState;
            console.log(`${nickname} is on ${agent}`);
        }
    }

    onActivePeerClick(_event) { }

    // PEERS
    ensurePeerCheck(viewId) {
        if (!this.peerChecks[viewId]) this.peerChecks[viewId] = {};
        return this.peerChecks[viewId];
    }
    onPeerIntendedState(data) {
        const { viewId } = data;
        if (viewId === this.viewId) return; // don't care what we're telling others

        this.chatPeerManager.setPeerLastAnnounce(viewId); // to keep the peer alive in checkForInactivePeers

        if (!this.payAttentionToIntendedStates) return;

        // if an Agora change has been received within the last
        // 2000ms, ignore this event (since it might be based on
        // pre-change state).
        const peerCheck = this.ensurePeerCheck(viewId);
        if ((peerCheck.ignoreUntil || 0) > Date.now()) return;

        if (peerCheck.deferred) window.clearTimeout(peerCheck.deferred);

        // similarly, delay acting on the event for 2000ms, in case
        // the corresponding Agora change is about to arrive.  publishing
        // video, in particular, can sometimes take a second or more.
        peerCheck.deferred = window.setTimeout(() => {
            delete peerCheck.deferred;
            this._checkPeerIntendedState(data);
        }, 2000);
    }
    postponePeerCheck(viewId) {
        // when an Agora change arrives, ignore any Croquet event
        // from the last 2000ms (which will have been set up as
        // deferred) and in the next 2000ms.
        const peerCheck = this.ensurePeerCheck(viewId);

        if (peerCheck.deferred) {
            window.clearTimeout(peerCheck.deferred);
            delete peerCheck.deferred;
        }
        peerCheck.ignoreUntil = Date.now() + 2000;
    }
    _checkPeerIntendedState({ viewId, audioMuted, videoMuted }) {
        // under v4, purely diagnostic
        // the args are as provided through Croquet; we compare against our records
        // of the Agora chat state
        if (!this.isPeerKnown(viewId)) return;

        const muteStr = bool => bool ? "muted" : "unmuted";
        const peerState = this.peerCombinedState(viewId);
        const { audioDisabled, videoDisabled } = peerState;
        let mismatch = false;
        if (audioMuted !== undefined) {
            const disabled = !!audioMuted; // "unavailable" => true
            if (audioDisabled !== disabled) {
                console.warn(`${viewId} audio state mismatch: reporting ${muteStr(disabled)}, but Agora is ${muteStr(audioDisabled)}`);
                mismatch = true;
            }
        }

        if (videoMuted !== undefined) {
            const disabled = !!videoMuted;
            if (videoDisabled !== disabled) {
                console.warn(`${viewId} video state mismatch: reporting ${muteStr(disabled)}, but Agora is ${muteStr(videoDisabled)}`);
                mismatch = true;
            }
        }

        if (!!peerState.trackMismatch !== mismatch) {
            const state = this.croquetPeerState[viewId]; // so we can update it
            state.trackMismatch = mismatch;
            this.updatePeerEphemeralProperties(viewId);
        }
    }

    onPeerExit(viewId) {
        // view-side handling of croquet view-exit (which
        // should only be received for a remote view).
        // if the peer is still known to Agora, don't remove
        // its record but mark it as offline.  if the Agora
        // stream also disappears, that will then cause removal.
        if (viewId === this.viewId) throw Error("view-exit received for local view");

        if (this.isKnownChatPeer(viewId)) {
            console.warn(`peer exit: ${viewId} marked as offline`);
            const state = this.croquetPeerState[viewId];
            if (state) {
                state.offline = true;
                if (isVideoAllowed) this.updatePeerEphemeralProperties(viewId);
            }
        } else {
            console.log(`peer exit: ${viewId} removed`);
            this.removePeer(viewId);
        }
    }

    addPeer(viewId, state) {
// console.log(`addPeer ${viewId}`, state);
        if (isVideoAllowed) {
            this.appendPeerContainer(viewId);
            this.onPeerHand({ viewId, raisingHand: state.raisingHand });
        }

        const numPeers = this.numberOfPeers;
        if (numPeers >= 2) {
            this.elements.ui.classList.remove('alone');
            this.chatPeerManager.ensureConnected();
        }

        if (isVideoAllowed && numPeers < 3) this.setDefaultActivePeer();
    }

    provisionallyRemovePeer(viewId) {
        if (this.isPeerKnown(viewId)) {
            const state = this.peerCombinedState(viewId);
            if (state.offline) this.removePeer(viewId);
        }
    }

    removePeer(viewId) {
        // sent from provisionallyRemovePeer if the peer had
        // already disappeared from the croquet session, and
        // (complementarily) from onPeerExit if the Agora
        // manager believes the peer has left the chat.
        // remove the peer's croquetPeerState and its container,
        // and set a default active peer if needed.
        if (isVideoAllowed) this.onPeerHand({ viewId, raisingHand: false });
        // delete the peer record before removing its container,
        // so the right number of peers are found for setting the
        // peers-region style.
        delete this.croquetPeerState[viewId];
        if (isVideoAllowed) this.removePeerContainer(viewId);
        this.chatPeerManager.removePeerState(viewId);

        // if local peer is connected, but the number of peers has now been reduced to 1
        // (i.e., we're now alone), leave the video chat.  if other peers
        // turn up in due course, we'll connect again.
        if (this.pendingDisconnectTimeout) {
            clearTimeout(this.pendingDisconnectTimeout);
            delete this.pendingDisconnectTimeout;
        }
        const numPeers = this.numberOfPeers;
        if (numPeers === 1) {
            // disconnecting immediately is too disruptive if other peer was just
            // reloading.  it was avoided when rejoinLimit was the default 1000ms,
            // because by the time we heard about the departure we'd already heard
            // about the new peer.  but that confused the tab of the rejoining peer,
            // which would see its own old identity in the model.
            // so now we have rejoinLimit=0 so everyone hears as soon as a peer leaves,
            // and set a timeout on the disconnection in case that peer is coming back.
            this.pendingDisconnectTimeout = setTimeout(() => {
                delete this.pendingDisconnectTimeout;
                if (this.numberOfPeers > 1) return; // someone else turned up

                this.elements.ui.classList.add('alone');
                this.elements.ui.classList.remove('play-blocked');
                this.chatPeerManager.ensureDisconnected();
            }, 1000);
            // fall through...
        }

        // if the removal of this peer takes the number of known peers
        // to 2, petition the model to set 'solo' mode.
        // ...and also if this is the last peer in the session, so that
        // when peers rejoin, the session is guaranteed to be in the
        // "normal" state of starting in solo mode.
        // ...except that if the last two peers leave at the same time,
        // and immediately after the third, their set-solo messages will
        // never be sent.  we now detect and fix that state in the model's
        // onChatPeerDetails, for the first peer to restart the session.
        if (isVideoAllowed) {
            if (numPeers < 3) {
                    this.publishToSession('set-solo', true);
                    this.setDefaultActivePeer();
            } else if (this.isDisplayedActivePeer(viewId)) {
                // it's the peer that was active that has gone away,
                // so put in a request to reset activePeer.
                // because this might be in a race with a
                // 'set-active-peer' nominating someone else,
                // use the explicit event 'remove-active-peer' with
                // the viewId as the argument.  the model will only
                // act if that viewId is still the active one.
                this.publishToSession('remove-active-peer', viewId);
            }
        }
    }

    setDefaultActivePeer() {
        // sent when peers < 3 from addPeer, removePeer,
        // setKnownPeers
        const numPeers = this.numberOfPeers;
        if (numPeers === 1) this.setActivePeer(null);
        else if (numPeers === 2) {
            const peerStreamIds = this.knownPeerIds();
            const otherPeerViewId = peerStreamIds.find(viewId => viewId !== this.viewId);
            this.setActivePeer(otherPeerViewId);
        }
    }

    setKnownPeers(peerSnapDict) {
        // remove all raising-hand annotations (they'll be rebuilt from
        // the individual peers)
        if (isVideoAllowed) {
            const handsElement = this.elements.peersRaisingHands;
            handsElement.querySelectorAll('.peerRaisingHand').forEach(handContainer => handContainer.remove());
            handsElement.classList.remove('someHands');
        }

        const peerIds = Object.keys(peerSnapDict);
        peerIds.forEach(vId => this.setPeerStateFromModel(vId, peerSnapDict[vId]));

        // remove peers that are no longer listed.
        // doing this *after* adding any previously unknown peers
        // from peerSnaps reduces the risk of triggering a spurious
        // drop into 'solo' mode.
        this.knownPeerIds().forEach(viewId => {
            if (!peerIds.includes(viewId)) this.removePeer(viewId);
        });

        if (this.numberOfPeers === 1) {
            this.elements.ui.classList.add('alone');
            this.elements.ui.classList.remove('play-blocked');
        }
        if (isVideoAllowed && this.numberOfPeers < 3) this.setDefaultActivePeer();
    }

    knownPeerIds() {
        return Object.keys(this.croquetPeerState);
    }

    filteredPeerIds(fn) {
        const ids = [];
        this.knownPeerIds().forEach(viewId => {
            if (fn(this.peerCombinedState(viewId))) ids.push(viewId);
        });
        return ids;
    }

    get numberOfPeers() { return this.knownPeerIds().length; }
    isPeerKnown(viewId) { return !!this.croquetPeerState[viewId]; }
    peerCombinedState(viewId) { return { ...this.croquetPeerState[viewId], ...this.chatPeerManager.ensurePeerState(viewId) }; }
    get isLocalPeerKnown() { return this.isPeerKnown(this.viewId); }

    // RESIZE OBSERVER
    resizeObserverCallback(entries) {
        const now = Date.now();
        entries.forEach(entry => {
            const timestamp = entry.target.dataset.resizeObserverTimestamp || 0;
            const timeSinceLastInvocation = now - timestamp;

            if (entry.target.dataset.resizeObserverTimeoutId) {
                window.clearTimeout(entry.target.dataset.resizeObserverTimeoutId);
                delete entry.target.dataset.resizeObserverTimeoutId;
            }

            const delay = this.resizeObserverConfiguration.delay;
            if (timeSinceLastInvocation >= delay) {
                this._resizeObserverCallback(entry);
                entry.target.dataset.resizeObserverTimestamp = now;
            } else {
                const remainingDelay = delay - timeSinceLastInvocation;
                entry.target.dataset.resizeObserverTimeoutId = window.setTimeout(this.resizeObserverCallback.bind(this, [entry]), remainingDelay);
            }
        });
    }
    _resizeObserverCallback(entry) {
        switch (entry.target) {
            case this.elements.activePeer:
                this.updateActivePeerContainerStyle();
                break;
            case this.elements.peers:
                this.updatePeersContainerStyle();
                break;
            default:
                if (entry.target.classList.contains('peer')) {
                    this.updatePeerContainerStyle(entry.target);
                }
                break;
        }
    }

    onResize(_event) {
        // only called if browser provides no ResizeObserver
        const now = Date.now();
        const timeSinceLastInvocation = now - this.resizeConfiguration.timestamp;

        if (this.resizeConfiguration.timeoutId) {
            window.clearTimeout(this.resizeConfiguration.timeoutId);
            delete this.resizeConfiguration.timeoutId;
        }

        if (timeSinceLastInvocation >= this.resizeConfiguration.delay) {
            this._onResize();
            this.resizeConfiguration.timestamp = now;
        } else {
            const delay = this.resizeConfiguration.delay - timeSinceLastInvocation;
            this.resizeConfiguration.timeoutId = window.setTimeout(this.onResize.bind(this), delay);
        }
    }
    _onResize() {
        // @@ used to call updateActivePeerContainerStyle first,
        // but that seems backwards
        this.updatePeersContainerStyle();
        this.updateActivePeerContainerStyle();

        this.elements.peers.querySelectorAll('.peer').forEach(peerContainer => this.updatePeerContainerStyle(peerContainer));
    }


    // EVENTLISTENERS
    onWheel(event) { event.preventDefault(); }

    // @@ we could remove these intermediate methods
    onToggleAudioClick() { this.toggleAudio(); }
    onToggleVideoClick() { this.toggleVideo(); }
    onToggleSoloClick() { this.toggleSolo(); }
    onToggleMicrophoneTestClick(event) {
        if (event.shiftKey) {
            console.log("gathering logs from all peers...");
            this.publishToSession('gather-logs', { initiator: this.viewId, reason: 'debug' });
            return;
        }

        // don't allow mic testing if local audio is not available,
        // or if local stream hasn't been set up yet.
        if (!this.userWantsLocalAudio || !this.localMediaManager) return;

        if (this.elements.ui.classList.contains('testing-microphone'))
            this.stopTestingMicrophone();
        else
            this.testMicrophone();
    }

    ondevicechange() {
        this.localMediaManager.onDeviceChange();
    }
    // new user selection
    onAudioInput() { if (this.userWantsLocalAudio) this.localMediaManager.setAudioInput(); }
    onVideoInput() { if (this.userWantsLocalVideo) this.localMediaManager.setVideoInput(); }

    // AUDIO, VIDEO
    toggleAudio() {
        if (!this.localMediaManager || !this.isLocalPeerKnown || !this.userWantsLocalAudio) return;

        if (this.chatAudioMuted) {
            sessionConfiguration.micSettingInChat = 'on';
            this.unmuteChatAudio();
        } else {
            sessionConfiguration.micSettingInChat = 'off';
            this.muteChatAudio(); // keep the stream running (but empty)
        }
    }

    /*
   showAudioTooltip(){
        if (this.chatAudioMuted) {
            document.getElementById('toggleAudio').setAttribute('title', 'Unmute Mic');
        } else {
            document.getElementById('toggleAudio').setAttribute('title', 'Mute Mic');
        }
    }
    */

    async muteChatAudio(stopStream) {
console.log(`muting local audio; ${stopStream ? "also" : "not"} stopping stream`);
        this.chatAudioMuted = true;

        await this.ensureAudioMuteState(true);

        if (isVideoAllowed) {
            this.updatePeerEphemeralProperties(this.viewId);
            this.localMediaManager.streamMixer.canvasContext.filter = `grayscale(100%)`;
        }
        this.elements.ui.classList.add('mute-audio');

        if (stopStream) this.localMediaManager.stopAudioStream();
    }

    unmuteChatAudio() {
console.log("unmuting local audio");
        this.chatAudioMuted = false;

        this.stopTestingMicrophone();

        this.ensureAudioMuteState(false); // async; the publish could be held up awaiting connection
        if (isVideoAllowed) {
            this.updatePeerEphemeralProperties(this.viewId);
            this.localMediaManager.streamMixer.canvasContext.filter = `none`;
        }
        this.elements.ui.classList.remove('mute-audio');
    }

    toggleVideo() {
        if (!this.localMediaManager || !this.isLocalPeerKnown || !this.userWantsLocalVideo) return;
        if (this.chatVideoMuted) {
            sessionConfiguration.videoSettingInChat = 'on';
            this.unmuteChatVideo();
        } else {
            sessionConfiguration.videoSettingInChat = 'off';
            this.muteChatVideo(true); // also stop the stream
        }
    }

    /*
    showVideoTooltip(){
        if (this.chatVideoMuted) {
            document.getElementById('toggleVideo').setAttribute('title', 'Show Camera');
        } else {
            document.getElementById('toggleVideo').setAttribute('title', 'Hide Camera');
        }
    }
    */

    muteChatVideo(stopStream) {
console.log(`muting local video; ${stopStream ? "also" : "not"} stopping stream`);
        this.chatVideoMuted = true;

        this.ensureVideoMuteState(true); // async

        this.updatePeerEphemeralProperties(this.viewId);
        this.localMediaManager.streamMixer.stopDrawing(true); // true => clear
        this.elements.ui.classList.add('mute-video');

        if (stopStream) this.localMediaManager.stopVideoStream();
    }

    async unmuteChatVideo() {
console.log("unmuting local video");
        this.chatVideoMuted = false;

        // for video (unlike audio) the input-setup step is needed,
        // because when the user toggles video off we also stop the
        // stream.
        await this.localMediaManager.setVideoInput();

        if (!this.chatVideoMuted) { // still what the user wants
            this.ensureVideoMuteState(false); // async; the publish could be held up awaiting connection
            this.updatePeerEphemeralProperties(this.viewId);
            this.checkLocalVideoSize(); // waits 1000ms, then resizes own container(s)
            this.localMediaManager.streamMixer.startDrawing();
            this.elements.ui.classList.remove('mute-video');
        }
    }

    startAnnouncingStreamState() {
        this._announceStreamStateIntervalId = window.setInterval(this.announceStreamState.bind(this), 5000);
    }
    stopAnnouncingStreamState() {
        if (this._announceStreamStateIntervalId) {
            window.clearInterval(this._announceStreamStateIntervalId);
            delete this._announceStreamStateIntervalId;
        }
    }
    announceStreamState() {
        // currently set to announce every 5s if we have at least one
        // track published.
        // if not published, announce after at least 14s have passed
        // (i.e., typically after 15s).  a peer that doesn't hear
        // from us in 35s can assume that we've left the Agora chat.

        // not clear that we need this with the v4 upgrade, but it's
        // worth having in case peers still sometimes hang around by mistake.

        // don't try to announce if the Croquet session is offline.
        if (this.isCroquetOffline) return;

        const peerState = this.chatPeerManager.localPeerState;
        if (!peerState.published && peerState.lastAnnounce && Date.now() - peerState.lastAnnounce < 14000) return;

        this.chatPeerManager.setPeerLastAnnounce(this.viewId);
        this.publishToSession('peer-intended-state', { viewId: this.viewId, audioMuted: this.chatAudioMuted, videoMuted: this.chatVideoMuted });
    }

    // UI
    onMouseDown(_event) {
        if (this.elements.ui.classList.contains('solo')) return;

        // const {flexDirection} = getComputedStyle(this.elements.ui);
        if (this.elements.ui.classList.contains('resize'))
            this.elements.ui.classList.add('resizing');
        else
            this.elements.ui.classList.remove('resizing');
    }
    onMouseMove(event) {
        if (this.elements.ui.classList.contains('solo')) return;

        const {flexDirection} = getComputedStyle(this.elements.ui);

        if (flexDirection.includes('row')) {
            if (Math.abs(event.clientX - this.elements.peers.offsetWidth) < 15)
                this.elements.ui.classList.add('resize');
            else
                this.elements.ui.classList.remove('resize');
        } else if (Math.abs(event.clientY - this.elements.peers.offsetTop) < 15)
            this.elements.ui.classList.add('resize');
        else
            this.elements.ui.classList.remove('resize');

        if (this.elements.ui.classList.contains('resizing')) {
            if (flexDirection.includes('row')) {
                // const width = this.elements.peers.clientWidth + event.movementX;
                let flexBasis = 100 * event.clientX / this.elements.ui.clientWidth;
                this.elements.peers.style.flexBasis = `${flexBasis}%`;
            } else {
                // const height = this.elements.peers.clientHeight - event.movementY;
                let flexBasis = 100 * (this.elements.ui.clientHeight - event.clientY) / this.elements.ui.clientHeight;
                this.elements.peers.style.flexBasis = `${flexBasis}%`;
            }
        }
    }
    onMouseUp(_event) {this.elements.ui.classList.remove('resizing');}


    // SOLO
    toggleSolo() {
        this.publishToSession('set-solo', !this.solo);
    }

    onUpdateSolo(solo) {
        // handler for update-solo from model.  also invoked
        // directly when the chatManager is created or is
        // re-initialised from model state.
        if (!isVideoAllowed || this.solo === solo) return;

        this.solo = solo;

        let title = solo ? "Show Audience" : "Hide Audience";
        if (solo) {
            // solo mode.  local peer's video is always fed to
            // localVideoCanvas.
            // if local peer is not the active peer, that canvas
            // is shown as an inset.
            this.localMediaManager.addOutputCanvas(this.elements.localVideoCanvas);
            this.elements.ui.classList.add('solo');

            // given the current setting for active peer,
            // disable all videos that won't be on display.
            // (v4) not sure this is needed.  try without.
            // const activePeerId = this.getDisplayedActivePeer();
            // this.knownPeerIds().forEach(viewId => {
            //     if (viewId !== this.viewId && viewId !== activePeerId) {
            //         this.ensurePeerVideoDisplayState(viewId, false);
            //     }
            // });
            this.updateHiddenAudience();
        } else {
            // not solo mode.  if local peer is not the active peer,
            // disconnect its video from localVideoCanvas.
            if (!this.isDisplayedActivePeer(this.viewId)) {
                this.localMediaManager.removeOutputCanvas(this.elements.localVideoCanvas);
            }
            this.elements.ui.classList.remove('solo');
            // (v4) not sure this is needed.  try without.
            // this.knownPeerIds().forEach(viewId => {
            //     if (viewId !== this.viewId) {
            //         this.ensurePeerVideoDisplayState(viewId, true);
            //     }
            // });

            // force a recalculation of peers' size, because if the tab is
            // inactive there won't be a resize driven by the .solo setting
            this.updatePeersContainerStyle(); // includes updateHiddenAudience
        }
        this.elements.toggleSolo.setAttribute("title", title);
    }

    // TEST MICROPHONE
    testMicrophone() {
        if (this.elements.localAudio.paused)
            this.elements.localAudio.play();

        if (!this.chatAudioMuted) this.muteChatAudio();

        this.elements.localAudio.muted = false; // make it audible
        this.elements.ui.classList.add('testing-microphone');
    }
    stopTestingMicrophone() {
        this.elements.localAudio.muted = true; // silence, but don't remove
        this.elements.ui.classList.remove('testing-microphone');
    }


    // PEERS DISPLAY
    appendPeerContainer(viewId) {
// console.log(`appendPeerContainer for ${viewId}`);
        const peer = this.peerCombinedState(viewId);
        const peerContainer = this.elements.peerTemplate.content.cloneNode(true).querySelector('.peer');

        /*
        this.addEventListener(peerContainer.querySelector('.mutePeer'), 'click', _event => {
            this.mutePeer(viewId);
        });
        */
        this.addEventListener(peerContainer, 'click', this.onPeerContainerClick);

        if (this.resizeObserver)
            this.resizeObserver.observe(peerContainer);

        if (this.viewId === viewId)
            peerContainer.classList.add('self');

        peerContainer.dataset.viewId = viewId;
        peerContainer.id = `peer-${viewId}`;
        this.updatePeerDefiningStyle(peerContainer, peer);
        this.updatePeerEphemeralStyle(peerContainer, peer);

        this.elements.peers.appendChild(peerContainer);

        // if we already have Agora tracks for this peer, attach them
        const videoTrack = this.getPeerMedia(viewId, 'video');
        if (videoTrack ) this.onPeerMedia(viewId, 'video', videoTrack);
        // and if there's an audio track, play it
        const audioTrack = this.getPeerMedia(viewId, 'audio');
        if (audioTrack) this.onPeerMedia(viewId, 'audio', audioTrack);

        this.updatePeersContainerStyle();
        this.updatePeerContainerStyle(peerContainer);
    }
    getPeerContainer(viewId) { return this.elements.peers.querySelector(`.peer[data-view-id="${viewId}"]`); }
    // ensurePeerVideoDisplayState(viewId, bool) {
    //     this.ensureVideoMuteState(viewId, !bool);
    //     this.updatePeerEphemeralProperties(viewId);
    // }

    removePeerContainer(viewId, shutdown = false) {
        // console.log(`removePeerContainer for ${viewId}`);
        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) {
            peerContainer.remove();
            if (this.resizeObserver) this.resizeObserver.unobserve(peerContainer);

            if (!shutdown) this.updatePeersContainerStyle();
        }
    }

    setActivePeerVideo(videoTrackOrNull) {
        let src = null;
        if (videoTrackOrNull) {
            src = new MediaStream(); // srcObject needs a stream
            src.addTrack(videoTrackOrNull.getMediaStreamTrack());
        }
        this.elements.activePeerVideo.srcObject = src;
    }

    attachPeerAudio(viewId, audioTrack) {
        if (viewId !== this.viewId) audioTrack.play(); // don't play our own audio

        if (isVideoAllowed) {
            const peerContainer = this.getPeerContainer(viewId);
            if (peerContainer) this.updatePeerContainerStyle(peerContainer);
            this.updatePeerEphemeralProperties(viewId); // can affect both peerContainer and activePeer
        }
    }

    removePeerAudio(viewId) {
        if (!isVideoAllowed) return;

        // const audioTrack = this.getPeerMedia(viewId, 'audio');
        // if (audioTrack) audioTrack.stop();
        // else console.log(`failed to find audio track for ${viewId}`);

        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) this.updatePeerContainerStyle(peerContainer);

        this.updatePeerEphemeralProperties(viewId);
    }

    attachPeerVideo(viewId, videoTrack) {
        // v4
        // put the remote peer's video track into the peerContainer prepared
        // for the peer, if it exists.
        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) {
            if (this.viewId === viewId) {
                const compositingCanvas = this.localMediaManager.compositingCanvas;
                peerContainer.appendChild(compositingCanvas);
            } else {
                // Agora will put a div#player_<id> into the specified
                // element.
                videoTrack.play(peerContainer.id, { fit: 'contain' });
                const video = peerContainer.querySelector('video');
                // add handler for resize of the video - for example, when auto-rotating on a mobile device
                if (video) video.addEventListener('resize', () => this.updatePeerContainerStyle(peerContainer));
// videoTrack.on('video-element-visible-status', evt => console.log(`visibility for ${viewId}`, evt, video));

                if (this.isDisplayedActivePeer(viewId)) this.setActivePeerVideo(videoTrack);
            }

            this.updatePeerContainerStyle(peerContainer);
        }
        this.updatePeerEphemeralProperties(viewId); // can affect both peerContainer and activePeer
    }

    // under v4 we only need an element for the video.  for audio the track just gets sent play() and stop() messages.
    removePeerVideo(viewId) {
        // dispose of the DOM elements that were playing this track,
        // but not the peer container they were in.  that will be
        // removed if and when the croquet client also disappears.
        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) {
            // div#agora-video-player-... is added by Agora, now containing just
            // a video child element.  on unpublish, Agora automatically
            // destroys the element (so it'll be gone by the time we get here).
            // const player = peerContainer.querySelector('[id*="player"]');
            // if (player) player.remove();

            this.updatePeerContainerStyle(peerContainer);
        }
        this.updatePeerEphemeralProperties(viewId);
    }

    updatePeersContainerStyle() {
        // reformat to take account of addition or removal
        // of a peer container
        this.updateHiddenAudience();
        if (this.elements.ui.classList.contains('solo')) return;

        const peersElement = this.elements.peers;
        const {clientWidth, clientHeight} = peersElement;
        const aspectRatio = clientWidth / clientHeight;

        // const peerIds = this.knownPeerIds();
        // const peerContainers = peerIds.map(viewId => this.getPeerContainer(viewId));
        const numberOfPeers = this.numberOfPeers;

        let rows = 1;
        let columns = 1;

        while (numberOfPeers > rows * columns) {
            const aspectRatios = {
                row : Math.abs(aspectRatio - columns / (rows + 1)),
                column : Math.abs(aspectRatio - (columns + 1) / rows),
            };

            if (aspectRatios.row / aspectRatios.column < 1.33)
                rows++;
            else
                columns++;
        }

        // extremely wide or tall peer regions can lead to over-hasty
        // additions of columns bzw. rows.  see if one or the other can
        // be decreased without losing room for everyone.
        if (numberOfPeers) {
            if ((rows - 1) * columns >= numberOfPeers) rows--;
            else if ((columns - 1) * rows >= numberOfPeers) columns--;
        }

        const gridTemplateColumns = `repeat(${columns}, ${100 / columns}%)`;
        const gridTemplateRows = `repeat(${rows}, ${100 / rows}%)`;

        peersElement.style.gridTemplateRows = gridTemplateRows;
        peersElement.style.gridTemplateColumns = gridTemplateColumns;

        if (!window.ResizeObserver) {
            peersElement.querySelectorAll('.peer').forEach(peerContainer => this.updatePeerContainerStyle(peerContainer));
        }
    }
    updatePeerDefiningProperties(viewId) {
        const peerState = this.peerCombinedState(viewId);
        if (this.isDisplayedActivePeer(viewId))
            this.updatePeerDefiningStyle(this.elements.activePeer, peerState);

        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) {
            this.updatePeerDefiningStyle(peerContainer, peerState);
        }
    }
    updatePeerDefiningStyle(element, peerState) {
        // set up either a peer container or the active-peer
        // element with the attributes needed to present the
        // supplied peer details.
        const { peerIndex, nickname, viewColor } = peerState;
        let abbreviated = nickname;
        if (nickname) {
            const pieces = nickname.split(" ").filter(p => p.length > 0);
            if (pieces.length > 1) {
                const lastInitial = pieces[pieces.length - 1][0].toUpperCase();
                abbreviated = `${pieces[0]} ${lastInitial}`;
            }
        }

        element.querySelector('.nickname').innerText = nickname;
        element.querySelector('.abbreviated').innerText = abbreviated;

        // set the background and the text colour to the user's
        // viewColor.  the CSS will selectively override these
        // depending on the mute-video state.
        const peerInfo = element.querySelector('.peerInfo');
        peerInfo.style.backgroundColor = viewColor;
        peerInfo.style.color = viewColor;
        const muteImage = element.querySelector('.muteImage');
        muteImage.style.backgroundColor = viewColor;

        if (element !== this.elements.activePeer)
            element.style.order = peerIndex;
    }
    updatePeerEphemeralProperties(viewId) {
        const peerState = this.peerCombinedState(viewId);
        if (this.isDisplayedActivePeer(viewId))
            this.updatePeerEphemeralStyle(this.elements.activePeer, peerState);

        const peerContainer = this.getPeerContainer(viewId);
        if (peerContainer) {
            this.updatePeerEphemeralStyle(peerContainer, peerState);
        }
    }
    updatePeerEphemeralStyle(element, peerState) {
        // set up either a peer container or the active-peer
        // element with the attributes needed to present the
        // supplied peer details.
        [
            ['videoDisabled', 'mute-video'],
            ['audioDisabled', 'mute-audio'],
            ['published', 'published-tracks'],
            ['raisingHand', 'raisingHand'],
            ['trackMismatch', 'track-mismatch'],
            ['offline', 'offline']
        ].forEach(([property, attribute]) => {
            element.classList.toggle(attribute, !!peerState[property]);
        });

        // if displaying a remote peer, also check whether it is subscribed to
        // all the tracks this peer has published
        const viewId = element.dataset.viewId;
        if (viewId !== this.viewId) {
            const subs = peerState.subscriptionsToHere || [];
            const incomplete = (!this.chatAudioMuted && !subs.includes("a")) || (!this.chatVideoMuted && !subs.includes("v"));
            element.classList.toggle('fully-subscribed', !incomplete);
        }
    }
    updatePeerContainerStyle(peerContainer) {
        // adjust the peer container to account for the aspect
        // ratios of the container and of the video.

        // called from appendPeerContainer, attachPeerVideo,
        // updateActivePeerContainerStyle, _resizeObserverCallback,
        // and from updatePeersContainerStyle and onResize iff no
        // ResizeObserver present.

        // we rely on various tricks to coerce css into sizing and
        // placing the peerInfo element (rather than use JavaScript,
        // which inevitably leads to jumpiness).

        // we use the automatic resizing of a canvas
        // element styled with height=100% to determine the
        // estimated video width.
        // https://stackoverflow.com/questions/6148012/setting-element-width-based-on-height-via-css

        // when the peer container is tall, we used to use the
        // padding-bottom trick to set the peerInfoSizer element
        // height to that appropriate for the video aspect ratio.
        // https://stackoverflow.com/questions/1495407/maintain-the-aspect-ratio-of-a-div-with-css
        // ...but that didn't work on Safari or Firefox,
        // so now we try to do everything with canvas resizing.

        const viewId = peerContainer.dataset.viewId; // might be temporarily unset, on the active-peer container
        const aspectRatio = ((viewId && !this.peerCombinedState(viewId).videoDisabled) ? this.updatePeerContainerVideo(peerContainer) : null) || 1.333; // if video isn't ready, assume the most common aspect ratio
        const { clientWidth, clientHeight } = peerContainer;
        const minSize = Math.min(clientWidth, clientHeight);
        const peerInfo = peerContainer.querySelector('.peerInfo');
        peerInfo.style.fontSize = `${Math.round(Math.max(11, Math.min(18, minSize / 20)))}px`;

        if (clientWidth / clientHeight >= aspectRatio)
            peerContainer.classList.add('wide');
        else
            peerContainer.classList.remove('wide');

        const templateCanvas = peerContainer.querySelector('.templateCanvas');
        // keep height at 100.  set width based on aspect ratio.
        templateCanvas.width = Math.round(aspectRatio * 100);
    }
    updatePeerContainerVideo(peerContainer) {
        // returns the video's aspect ratio, if available.

        // if this container is showing self, there is no relevant
        // video element.  ask the streamMixer for the current
        // aspect ratio (which could still be undefined).
        if (peerContainer.classList.contains('self'))
            return this.localMediaManager.streamMixer.aspectRatio;

        const video = peerContainer.querySelector('video');
        const videoTrack = video && video.srcObject && video.srcObject.getVideoTracks()[0];
        if (videoTrack) {
            const { width, height } = videoTrack.getSettings();
            // width and height can be undefined
            if (width && height) {
                video.width = width;
                video.height = height;
                return width / height;
            }
        }
        return null;
    }

    mutePeer(viewId) {
        if (true) return; // @@ disabled, for now

        if (viewId) this.publishToSession('mute-peer-audio', viewId);
    }

    startRenderingPeerBorders() {
        this.stopRenderingPeerBorders();
        // peer borders currently rendered every 80ms.
        // when our stream analysers have buffers of 4096 samples,
        // they hold around 85ms at 48000 samples/sec.
        this._renderPeerBordersInterval = 80;
        this._renderPeerBordersIntervalId = window.setInterval(this.renderPeerBorders.bind(this), this._renderPeerBordersInterval);
    }
    renderPeerBorders() {
        const thisPeerId = this.viewId;
        const activePeerId = this.getDisplayedActivePeer();
        const thisIsActive = thisPeerId === activePeerId;
        let peerIds = [];
        if (this.solo) {
            const addIfRelevant = peerId => {
                if (!this.isPeerKnown(peerId)) return;

                const peer = this.peerCombinedState(peerId);
                if (peer.published && peer.videoDisabled && !peer.audioDisabled)
                    peerIds.push(peerId);
                };
            if (activePeerId) addIfRelevant(activePeerId);
            if (!thisIsActive) addIfRelevant(thisPeerId);
        } else {
            peerIds = this.filteredPeerIds(peer => peer.published && peer.videoDisabled && !peer.audioDisabled);
        }

        if (peerIds.length) {
            const MAX_PORTION = 0.2;
            const addShadow = (element, level, color) => {
                const minLength = Math.min(element.clientWidth, element.clientHeight);
                element.style.boxShadow = `inset 0px 0px ${level * minLength * MAX_PORTION}px ${level * minLength * MAX_PORTION}px ${color}`;
                };

            this.elements.ui.classList.add('renderingPeerBorders');

            peerIds.forEach(viewId => {
                const audioTrack = this.getPeerMedia(viewId, 'audio');
                if (audioTrack) {
                    const audioLevel = audioTrack.getMediaStreamTrack().getAudioLevel(this._renderPeerBordersInterval / 2); // grab existing value if recent enough
                    const viewColor = this.peerCombinedState(viewId).viewColor;

                    // if it's the active peer, mark the activePeer element
                    if (viewId === activePeerId)
                        addShadow(this.elements.activePeer.querySelector('.peerInfoSizer'), audioLevel, viewColor);

                    if (!this.solo) {
                        // if a peerContainer is visible, mark that
                        const peerContainer = this.getPeerContainer(viewId);
                        if (peerContainer)
                            addShadow(peerContainer.querySelector('.peerInfoSizer'), audioLevel, viewColor);
                    } else if (viewId === thisPeerId && !thisIsActive) {
                        // in solo with this peer as an inset, mark that -
                        // but boost the apparent level since the canvas
                        // is so small.
                        addShadow(this.elements.localVideoCanvas, Math.min(1, audioLevel * 3), viewColor);
                    }
                }
            });
        } else {
            this.elements.ui.classList.remove('renderingPeerBorders');
        }
    }
    stopRenderingPeerBorders() {
        if (this._renderPeerBordersIntervalId) {
            this.elements.ui.classList.remove('renderingPeerBorders');
            window.clearInterval(this._renderPeerBordersIntervalId);
            delete this._renderPeerBordersIntervalId;
        }
    }

    onPeerTrackSubscriptions({viewId, subscribed}) {
        if (!isVideoAllowed || viewId === this.viewId) return;

        // a remote peer is reporting the tracks that it is
        // currently subscribed to.  record the state, then
        // force a refresh of that viewId's display(s) to
        // reflect any change.
        const peerState = this.croquetPeerState[viewId];
        if (peerState) {
            peerState.subscriptionsToHere = subscribed[this.viewId];
            this.updatePeerEphemeralProperties(viewId);
        }
    }


    // ACTIVE PEER
    startPollingForActivePeer() {
        this._pollForActivePeerIntervalId = window.setInterval(this.pollForActivePeer.bind(this), 200);
    }
    pollForActivePeer() {
        const localPeer = this.peerCombinedState(this.viewId);
        const currentActivePeer = this.getDisplayedActivePeer();

        // nothing to do if
        //   this peer is offline, or
        //   it is hidden from view, or
        //   there are fewer than 3 clients in the session, or
        //   this peer is not published, or
        //   recently requested to be the active peer, or
        //   is currently the displayed active peer
        if (this.isCroquetOffline || document.visibilityState !== 'visible' || this.numberOfPeers < 3 || !localPeer.published || (this._lastRequestToBeActivePeer && Date.now() - this._lastRequestToBeActivePeer < 1500) || currentActivePeer === this.viewId) return;

        let request = false;

        // if this is the only published peer, request.
        // note that if a newly published peer requests to be
        // active (e.g., being the only unmuted one), Croquet's
        // update-active-peer event is likely to arrive before
        // Agora's stream-added.  so we count the current
        // active peer as being published, even if its state
        // hasn't been updated yet.
        if (this.filteredPeerIds(peer => peer.published).length === 1)
            request = "only peer published"; // (we've already confirmed localPeer.published)

        // otherwise, bail out if muted
        else if (localPeer.audioDisabled) return;

        // not muted - so if this is the only unmuted peer, request
        else if (this.filteredPeerIds(peer => !peer.audioDisabled).length === 1)
            request = "only peer unmuted";

        // or iff level is high enough
        else {
            const activePeerIsMuted = !currentActivePeer || !this.isPeerKnown(currentActivePeer) || this.peerCombinedState(currentActivePeer).audioDisabled;
            const levelNeeded = activePeerIsMuted ? 0.1 : 0.3;
            const audioLevel = Math.round(this.localMediaManager.getAudioLevel() * 100) / 100;
            if (audioLevel > levelNeeded) request = `audio level=${audioLevel} > ${levelNeeded}`;
        }

        if (request) {
            console.log(`requesting to be active: ${request}`);
            this.requestToBeActivePeer();
        }
    }
    requestToBeActivePeer() {
        this._lastRequestToBeActivePeer = Date.now();
        this.publishToSession('set-active-peer', this.viewId);
    }
    stopPollingForActivePeer() {
        if (this._pollForActivePeerIntervalId) {
            window.clearInterval(this._pollForActivePeerIntervalId);
            delete this._pollForActivePeerIntervalId;
        }
    }

    onUpdateActivePeer(activePeerId) {
        if (!isVideoAllowed) return;

        // an active-peer request will only be sent if there are
        // 3 or more peers in the session.  if the number of peers
        // happens to have dropped below 3 by the time the message
        // arrives, we must ignore it.  the active peer will have
        // been set by setDefaultActivePeer.
        if (this.numberOfPeers >= 3) this.setActivePeer(activePeerId);
    }

    setActivePeer(activePeerId) {
        if (!isVideoAllowed) return;

        // called from setDefaultActivePeer (when < 3 peers);
        // from removePeer when the removed peer was the active;
        // from the QChatView on setup (when >= 3 peers);
        // and in response to 'update-active-peer' from the model,
        // again if >= 3 peers.
        // activePeerId can be null.
        if (activePeerId && !this.isPeerKnown(activePeerId)) {
            console.error(`setActivePeer for unknown ${activePeerId}`);
            return;
        }

        if (activePeerId === this.getDisplayedActivePeer()) return; // a duplicate request

        this.elements.activePeer.querySelector('.peerInfoSizer').style.boxShadow = '';

        const peerDescription = activePeerId ? ` (${activePeerId === this.viewId ? "me" : "not me"})` : "";
console.log(`active peer=${activePeerId}${peerDescription} numPeers=${this.numberOfPeers}`);

        if (activePeerId) {
            this.elements.activePeer.dataset.viewId = activePeerId;

            const peerState = this.peerCombinedState(activePeerId);
            this.updatePeerDefiningStyle(this.elements.activePeer, peerState);
            this.updatePeerEphemeralStyle(this.elements.activePeer, peerState);

            const videoTrack = this.getPeerMedia(activePeerId, 'video'); // if it's there
            let outgoingVideoWidth = 480, outgoingFrameRate = 12; // unless told otherwise

            if (isBackdrop) {
                outgoingFrameRate = 30;
                outgoingVideoWidth = 1280;
            }

            if (activePeerId === this.viewId) {
                this.elements.activePeer.classList.add('self');
                this.setActivePeerVideo(null);

                // in solo mode, the local peer always feeds
                // localVideoCanvas.

                // in solo mode with 2 or fewer peers, the local peer
                // is never selected as active (i.e., we don't get here).

                // in solo mode with > 2 peers, localVideoCanvas appears
                // full size when local peer is active, otherwise
                // as an inset.

                // in non-solo mode, localVideoCanvas never appears as an
                // inset, and the local peer feeds it only when it is the
                // active peer.
                if (!this.solo) {
                    this.localMediaManager.addOutputCanvas(this.elements.localVideoCanvas);
                }
            } else {
                this.elements.activePeer.classList.remove('self');

                if (videoTrack) this.setActivePeerVideo(videoTrack);
                else {
                    // the incoming peer's stream apparently isn't available - so
                    // at least make sure we're not still showing the previous peer.
                    this.setActivePeerVideo(null);
                }

                if (!this.solo) {
                    // stop local video being shown
                    this.localMediaManager.removeOutputCanvas(this.elements.localVideoCanvas);
                }

                if (this.numberOfPeers > 2) {
                    outgoingVideoWidth = 240;
                    outgoingFrameRate = 12; // if it's too low, we've seen Agora do an automatic unpublish
                }
            }

            this.localMediaManager.width = outgoingVideoWidth;
            this.localMediaManager.frameRate = outgoingFrameRate;

            // in "solo", make sure that any out-of-sight peers
            // (not active, not local) are not displaying.
            if (this.solo) {
                // (v4) not sure this is needed.  try without.
                // this.knownPeerIds().forEach(viewId => {
                //     if (viewId !== this.viewId && viewId !== activePeerId) {
                //         this.ensurePeerVideoDisplayState(viewId, false);
                //     }
                // });
            }
        } else {
            // there is no active peer
            this.removeActivePeerDisplay();
        }

        this.updateActivePeerContainerStyle();
        this.updateHiddenAudience();
    }

    updateHiddenAudience() {
        // called from updatePeersContainerStyle, onUpdateSolo,
        // setActivePeer.
        // in solo (hidden-audience) mode, show a count of the number
        // of peers - if any - who are currently not being seen.
        let hiddenCount = 0;
        if (this.solo && this.numberOfPeers >= 3) {
            const activePeerId = this.getDisplayedActivePeer();
            hiddenCount = this.numberOfPeers - (activePeerId === this.viewId ? 1 : 2);
        }

        const hiddenAudience = this.elements.activePeer.querySelector('#hiddenAudience');
        if (hiddenCount > 0) {
            hiddenAudience.classList.add('someHidden');
            hiddenAudience.querySelector('span').textContent = `${hiddenCount} hidden`;
        } else {
            hiddenAudience.classList.remove('someHidden');
        }
    }

    removeActivePeerDisplay() {
        const activePeerElement = this.elements.activePeer;

        ['mute-video', 'mute-audio', 'self', 'raisingHand', 'published-tracks'].forEach(prop => {
            activePeerElement.classList.remove(prop);
        });

        delete activePeerElement.dataset.viewId;

        activePeerElement.querySelector('.nickname').innerText = '';
        activePeerElement.querySelector('.abbreviated').innerText = ''; // although right now activePeer doesn't use this

        const peerInfo = activePeerElement.querySelector('.peerInfo');
        delete peerInfo.style.backgroundColor;
        delete peerInfo.style.color;

        // when no-one's the active peer, there's no point in
        // anyone streaming high-resolution video.
        this.localMediaManager.width = 240;
        this.localMediaManager.frameRate = 5;
        this.setActivePeerVideo(null);
    }

    // getPeerIds() { return this.chatPeerManager.getPeerIds(); }
    isKnownChatPeer(viewId) { return this.chatPeerManager.isKnownPeer(viewId); }
    getPeerMedia(viewId, mediaType) { return this.chatPeerManager.getPeerMedia(viewId, mediaType); }
    ensureAudioMuteState(bool) { return this.chatPeerManager.ensureAudioMuteState(bool); }
    ensureVideoMuteState(bool) { return this.chatPeerManager.ensureVideoMuteState(bool); }

    updateActivePeerContainerStyle() {
        this.updatePeerContainerStyle(this.elements.activePeer);
    }

    // EVENT LISTENERS
    addEventListener(element, type, rawListener, options) {
        this._eventListeners = this._eventListeners || [];
        const boundListener = rawListener.bind(this);
        element.addEventListener(type, boundListener, options);
        this._eventListeners.push({element, type, boundListener, rawListener});
    }
    // NOT USED
    // NB: only removes first listener found!
    removeEventListener(element, type, rawListener) {
        const index = this._eventListeners.findIndex(spec => spec.element === element && spec.type === type && spec.rawListener === rawListener);
        if (index >= 0) {
            element.removeEventListener(type, this._eventListeners[index].boundListener);
            this._eventListeners.splice(index, 1);
        }
    }
    removeEventListeners() {
        this._eventListeners.forEach(({element, type, boundListener}) => {
            element.removeEventListener(type, boundListener);
        });
        this._eventListeners = [];
    }

    shutDown() {
        // @@ there might be some better ordering for all this.
        // current order:
        //   - remove event listeners
        //   - cancel interval-driven processes
        //   - cancel any active peer
        //   - disconnect the microphone-test local audio stream
        //   - clean up ui state properties (solo, connected etc)
        //   - stop local audio and video, and delete ref to stream

        //   - chatPeerManager shutDown:
        //     * cancel interval-driven processes
        //     * for every viewId send offPeerMedia to remove the DOM elements
        //     * tell Agora to disconnect

        //   - localMediaManager shutDown:
        //     * cancel interval-driven processes
        //     * close local audioContext and streamMixer

        //   - remove all peer containers, including own
        //   - remove all peer state, including own
        this.removeEventListeners();
        if (this.resizeObserver) this.resizeObserver.disconnect();

        this.stopPollingForActivePeer();
        this.stopRenderingPeerBorders();
        this.stopTestingMicrophone();

        if (isVideoAllowed) this.removeActivePeerDisplay();
        this.elements.localAudio.srcObject = null;
        ['solo', 'connected', 'published-tracks'].forEach(prop => {
            this.elements.ui.classList.remove(prop);
        });

        if (isVideoAllowed) this.localMediaManager.stopVideoStream();
        this.localMediaManager.stopAudioStream();

        this.chatPeerManager.shutDown();
        this.localMediaManager.shutDown();

        this.knownPeerIds().forEach(viewId => {
            if (isVideoAllowed) this.removePeerContainer(viewId, true); // shutdown = true
            delete this.croquetPeerState[viewId];
        });
    }
}

let theChatManager;
class QChatView extends Croquet.View {
    constructor(model) {
        // this can either be the first view instantiation
        // for this viewId, or a reconnection after a
        // period of dormancy (typically due to a network
        // glitch).
        super(model);
        this.model = model;

        // @@@ workaround for current Session API's inability
        // to stop a reconnection that's already in progress.
        // if the user has pressed Leave, bail out immediately.
        if (userLeft) {
            Croquet.Session.leave(this.sessionId);
            return;
        }

        this.isWaitingForLocalDetails = true;
        this.sendPeerDetails();

        this.lastLogSent = 0;
        this.sendPreviousLogs();
    }

    sendPeerDetails() {
        // tell the model that this view is joining the session
        // with the specified user details.
        // note that if no initials were provided (e.g., in a standalone
        // session), the first time through here will assign them.  therefore
        // if the user forces a leave and re-join, the new viewId will have
        // a fragment of the original viewId as its debug suffix.
        const { viewId } = this;
        let { nickname, initials, viewColor } = sessionConfiguration;
        if (nickname === '') nickname = sessionConfiguration.nickname = viewId;
        if (initials === '') initials = sessionConfiguration.initials = viewId.slice(0, 2);
        const rejoining = !!theChatManager?.isCroquetOffline; // coming back after a glitch?
        const agent = window.navigator.userAgent;

        this.publish(this.sessionId, 'peer-details', { viewId, nickname, initials, viewColor, agent, rejoining });

        this.subscribe(this.sessionId, 'on-peer-details', this.onPeerDetails);
    }

    onPeerDetails(viewId) {
        // on view initialisation (perhaps re-joining a
        // running chat), wait for the peer details for
        // the local view before going any further.
        const isLocalDetails = viewId === this.viewId;
        if (this.isWaitingForLocalDetails) {
            if (!isLocalDetails) return; // we'll catch up on this event using model data, once the local details are found

            this.isWaitingForLocalDetails = false;
            this.setUpSubscriptions();

            // if the chat manager has not yet been set up,
            // do so now.
            if (!theChatManager)
                theChatManager = new ChatManager(this.viewId);

            // if this is a reconnection, the chat manager will
            // send view-to-model messages to ensure the model
            // is up to date with what changed for the local
            // view during the time out.
            theChatManager.setQChatView(this);

            // whether the manager existed before or not,
            // feed it the details of all peers that have
            // supplied them.  if the manager was already
            // running, it will use all peer data to make
            // any necessary updates to its records (and
            // to the UI).
            const knownPeerDict = {};
            this.model.identifiedPeers().forEach(vId => knownPeerDict[vId] = this.model.peerSnapshotForId(vId));
            theChatManager.setKnownPeers(knownPeerDict);
            theChatManager.onUpdateSolo(this.model.solo);

            // if fewer than 3, the chatManager will already have
            // run setDefaultActivePeer
            if (isVideoAllowed && Object.keys(knownPeerDict).length >= 3)
                theChatManager.setActivePeer(this.model.activePeer);
        } else {
            // these must be the details for a remote peer.
            if (isLocalDetails) {
                console.warn("local details received twice", this.model.peerSnapshotForId(viewId));
                throw Error("local details received twice");
            }

            // console.warn(`onPeerDetails for ${viewId}`);
            const peerSnap = this.model.peerSnapshotForId(viewId);
            theChatManager.setPeerStateFromModel(viewId, peerSnap);

            // if the arrival of the peer takes the total of known
            // peers to 3, the views all petition the model to
            // release 'solo' state.  it doesn't matter that multiple
            // views will send the same event.
            // we handle that here, rather than in ChatManager.addPeer,
            // because here we know that we're dealing with the
            // arrival of a single newcomer (rather than syncing with
            // an established group of many peers, possibly with a
            // user-chosen 'solo' setting).
            if (theChatManager.numberOfPeers === 3)
                this.publish(this.sessionId, 'set-solo', false);
        }
    }

    setUpSubscriptions() {
        this.subscribe(this.sessionId, 'on-peer-intended-state', this.onPeerIntendedState);

        this.subscribe(this.sessionId, 'on-peer-exit', this.onPeerExit);

        this.subscribe(this.sessionId, 'update-active-peer', this.onUpdateActivePeer);
        this.subscribe(this.sessionId, 'update-solo', this.onUpdateSolo);

        // subscription notifications from remote peers are used to
        // update the hourglass indicators
        this.subscribe(this.sessionId, 'on-peer-track-subscriptions', this.onPeerTrackSubscriptions);

        this.subscribe(this.sessionId, 'on-peer-hand', this.onPeerHand);

        this.subscribe(this.sessionId, 'on-gather-logs', this.onGatherLogs);
        this.subscribe(this.sessionId, 'on-peer-log', this.onPeerLog);
    }

    onPeerIntendedState(data) { theChatManager.onPeerIntendedState(data); }
    onPeerExit(data) { theChatManager.onPeerExit(data); }
    onUpdateActivePeer(data) { theChatManager.onUpdateActivePeer(data); }
    onUpdateSolo(data) { theChatManager.onUpdateSolo(data); }
    onPeerTrackSubscriptions(data) { theChatManager.onPeerTrackSubscriptions(data); }
    onPeerHand(data) { theChatManager.onPeerHand(data); }

    onGatherLogs({ reason, initiator }) {
        if (initiator === this.viewId) return;

        this.sendLog(reason, initiator);
    }

    async sendLog(reason, initiator = this.viewId, viewId = this.viewId, text = logText, timestamp = Date.now()) {
        if (!text) return;

        // rate-limit log uploads to 1 per minute
        if (reason !== 'prev' && timestamp - this.lastLogSent < 60000) return;

        this.lastLogSent = timestamp;

        const encoder = new TextEncoder();
        const buf = encoder.encode(text).buffer;
        const handle = await Croquet.Data.store(this.sessionId, buf);
        this.publish(this.sessionId, 'peer-log', { timestamp, initiator, reason, viewId, handle });
    }

    sendPreviousLogs() {
        // send previous log now after reload
        for (const previous of previousLogs) {
            if (previous.persistentId === this.session.persistentId) {
                this.sendLog('prev', this.viewId, previous.viewId, previous.log, previous.timestamp);
                try {
                    delete localStorage[previous.key];
                } catch (_) { /* ignore */}
            }
        }
        // send (presumably successful) log after 3 min, plus get everyone else's for context
        const getAllLogs = () => {
            if (!this.id) return; // view has been detached

            this.sendLog('auto');
            this.publish(this.sessionId, 'gather-logs', { initiator: this.viewId, reason: 'auto' });
            };
        setTimeout(getAllLogs, 3 * 60 * 1000);
    }

    async onPeerLog({ initiator, reason, viewId, handle }) {
        // the log has already been stored in the model.  here we
        // just decide whether to also throw it into our console.
        // the only logs written to the console are those sent
        // for the 'debug' reason, with this view as the initiator.
        if (initiator !== this.viewId || reason !== 'debug') return;

        const buf = await Croquet.Data.fetch(this.sessionId, handle);
        const peerLog = new TextDecoder().decode(buf);
        console.__log(`log from ${viewId}:\n${peerLog}`);
    }

    detach() {
        super.detach();

        if (theChatManager) theChatManager.setQChatView(null);
    }
}

const mainAudioContext = new (window.AudioContext || window.webkitAudioContext)(); // default sample rate of 48000
function resumeAudioContextIfNeeded() {
    // on Safari (at least), the audioContext doesn't start
    // in 'running' state.
    if (mainAudioContext.state !== 'running' && mainAudioContext.state !== 'closed') {
        console.log("attempting to resume mainAudioContext");
        mainAudioContext.resume();
    }
}


let sessionId;
let persistentId;
let viewId;
let joinSent = false;
let userLeft = false;
function joinSession() {
    console.log(`Agora chat joinSession ${sessionConfiguration.channelName}`);
    userLeft = false;
    cover?.classList.add('hidden');
    joinDialog?.classList.add('hidden');
    ui.classList.remove('hidden');
    ui.classList.add('joining');
    const tooltip = document.getElementById('connection-tooltip');
    if (tooltip) tooltip.style.display = 'none';
    document.getElementById('toggleConnection').setAttribute("title", "Leave Call");
    joinSent = true; // never reset - but for now only checked in the page's root-level code, in case of a race with some other join path
    Croquet.App.root = false;
    const joinArgs = {
        appId: window.sessionConfiguration.appId,
        apiKey: window.sessionConfiguration.apiKey,
        name: sessionConfiguration.channelName,
        password: 'dummy-pass',
        model: window.QChatModel,
        view: QChatView,
        autoSleep: false,
        tps: 4,
        viewIdDebugSuffix: sessionConfiguration.initials,
        rejoinLimit: 0 // bail out immediately, to reduce the chance of a reloaded page finding its former view still in the model
        // debug: ["messages"] // ["session"]
        };
    Croquet.Session.join(joinArgs)
        .then(_session => {
            console.log("Croquet session joined");
            ui.classList.remove('unconnected');
            ui.classList.remove('joining');
            sessionId = _session.id;
            persistentId = _session.persistentId;
            viewId = _session.view.viewId;
            if (parentConnection) {
                parentConnection.setConnectedFrameSize();
                parentConnection.sendChatJoined();
            }
        });
}

function leaveSession() {
    console.log("Agora chat leaveSession");
    userLeft = true;
    ui.classList.add('unconnected');
    ui.classList.add('solo');
    document.getElementById('toggleSolo')?.setAttribute("title", "");
    ui.classList.remove('alone');
    ui.classList.remove('play-blocked');
    if (theChatManager) {
        theChatManager.setQChatView(null);
        theChatManager.shutDown();
        theChatManager = null;
    }
    if (sessionId) Croquet.Session.leave(sessionId);
    sessionId = null;
    document.getElementById('toggleConnection').setAttribute("title", "Join Call");
    if (parentConnection) parentConnection.sendChatLeft();
}

function toggleConnection() {
    // the join/leave button.
    // @@@ if the croquet session happens to have gone away - due to a
    // network glitch, rather than a user request - when the button is
    // pressed, we can't currently stop the session from automatically
    // reconnecting.  for now, QChatView constructor checks 'userLeft'
    // and bails out if it's set.
    // needs a bit of a change in teatime.
    resumeAudioContextIfNeeded(); // direct from a click, as required
    if (!ui.classList.contains('unconnected')) leaveSession();
    else joinSession();
}
document.getElementById('toggleConnection').addEventListener('click', toggleConnection);

function toggleSettings() {
    ui.classList.toggle('hide-settings');
    if (parentConnection && sessionConfiguration.resizeFrame) {
        if (ui.classList.contains('hide-settings')) parentConnection.setConnectedFrameSize();
        else parentConnection.setSettingsFrameSize();
    }
}
document.getElementById('toggleSettings').addEventListener('click', toggleSettings);

const messenger = Croquet.Messenger;
class ParentConnection {
    constructor() {
        if (cover) {
            // if there is a cover element, and the hosting app doesn't quickly deliver
            // the session info we need, put up the cover to invite the user to start
            // the session manually.
            this.clickEnableTimeoutId = window.setTimeout(() => {
                cover.classList.remove('hidden');
                cover.addEventListener('click', _event => {
                    resumeAudioContextIfNeeded();
                    joinSession();
                    }, { once: true });
            }, 500);
        }

        messenger.setReceiver(this);
        messenger.on('sessionInfo', 'onSessionInfo');
        messenger.on('userInfo', 'onUserInfo');
        messenger.on('videoChatInitialState', 'onVideoChatInitialState');
        messenger.on('activeInChat', 'onActiveInChat');

        // messages for stoppable, restartable calls
        messenger.on('joinChat', 'onJoinChat');
        messenger.on('leaveChat', 'onLeaveChat');

        this.receivedSessionInfo = false;
        this.receivedUserInfo = false;
        this.receivedVideoChatInitialState = false;

        const deepNested = window.parent.parent !== window.parent;
        if (deepNested) {
            // we tell the Messenger it's not in an iframe, because it assumes that
            // if it *is* in an iframe then the parent must be the top window.
            // in this situation, all messages to the parent must explicitly identify
            // the parent frame as the target.

            // in addition: on join, if Messenger is ready it's told to detach.  in this
            // case it will be ready, because we've set the receiver in order to communicate
            // with the parent frame to get the session-start parameters.  we therefore
            // subvert the detach() method, so the Messenger remains active across the
            // session start.
            messenger.isInIframe = false; // hack
            const messengerSend = messenger.send.bind(messenger);
            messenger.send = (event, data, directWindow) => {
                messengerSend(event, data, directWindow || window.parent);
            };
            messenger.detach = () => { }; // bigger hack
        }

        if (sessionConfiguration.requestName) {
            // const dialogClose = document.getElementById('dialogCloseButton');
            // dialogClose.addEventListener('click', () => this.dialogCloseNoJoin());

            const nameField = document.getElementById('nameField');
            nameField.addEventListener('keydown', evt => this.nameFieldKeydown(evt));
            nameField.addEventListener('input', _evt => this.nameFieldChanged());

            const joinButton = document.getElementById('joinButton');
            joinButton.addEventListener('click', () => this.dialogCloseJoin());

            const dontJoinButton = document.getElementById('dontJoinButton');
            dontJoinButton.addEventListener('click', () => this.dialogCloseNoJoin());

            const avatarURLField = document.getElementById('avatarURLField');
            avatarURLField.addEventListener('input', () => this.avatarURLFieldChanged());
        }

        this.requestInfo();
    }

    onSessionInfo({ sessionHandle, ephemeralSessionHandle }) {
        // feb 2021: channelName is used both for the Croquet session
        // name and for the Agora channel.  it used to be based on
        // the persistentId of the Greenlight session, but to avoid
        // the confusion caused by being in the same chat session even
        // if Greenlight has been updated, we now use the ephemeral
        // (session-specific) handle.  for now the persistent handle
        // is still included, as a prefix, to help track the migration
        // of GL versions in the reflector and Agora logs.
        // Greenlight and Microverse send handles of different length;
        // we only use the first 8 characters of each.
        sessionConfiguration.channelName = sessionHandle.slice(0, 8) + ":" + ephemeralSessionHandle.slice(0, 8);
        console.log(`Agora channel name = ${sessionConfiguration.channelName}`);

        this.receivedSessionInfo = true;
        this.checkIfReadyToJoinSession();
    }

    onUserInfo({ nickname, initials, userColor, viewId: userViewId }) {
        if (nickname)
            sessionConfiguration.nickname = nickname;

        if (initials) {
            if (/[^_a-z0-9]/i.test(initials)) {
                initials = userViewId.slice(-2);
            }
            sessionConfiguration.initials = initials;
        }

        if (userColor) {
            sessionConfiguration.userColor = userColor;
            sessionConfiguration.viewColor = userColor;
        }

        this.receivedUserInfo = true;
        this.checkIfReadyToJoinSession();
    }

    onVideoChatInitialState({ mic, video, fromLandingPage, cameraDeviceId, cameraDeviceLabel, micDeviceId, micDeviceLabel }) {
        console.log("initial state from parent:", { mic, video, micDeviceLabel, cameraDeviceLabel });
        if (mic && !isBackdrop)
            sessionConfiguration.mic = mic;

        if (video && !isBackdrop)
            sessionConfiguration.video = video;

        // fromLandingPage isn't supplied by an in-microverse call requester
        sessionConfiguration.fromLandingPage = fromLandingPage;

        if (cameraDeviceId)
            sessionConfiguration.cameraDeviceId = cameraDeviceId;

        if (cameraDeviceLabel)
            sessionConfiguration.cameraDeviceLabel = cameraDeviceLabel;

        if (micDeviceId)
            sessionConfiguration.micDeviceId = micDeviceId;

        if (micDeviceLabel)
            sessionConfiguration.micDeviceLabel = micDeviceLabel;

        this.receivedVideoChatInitialState = true;
        this.checkIfReadyToJoinSession();
    }

    get receivedAllData() { return this.receivedSessionInfo && this.receivedUserInfo && this.receivedVideoChatInitialState; }

    checkIfReadyToJoinSession() {
        if (!this.receivedAllData) return; // still waiting for some data from parent

        if (sessionConfiguration.parentJoinLeave) {
            // parentJoinLeave implies a two-phase setup in which the chat lets
            // the parent know when it is ready to join the chat session.  when
            // requestName is also true, the chat has responsibility for requesting
            // the user's nickname and won't send chatReady until that has
            // happened, or when the parent has already sent a nickname as part
            // of the userInfo.
            const { nickname, requestName } = sessionConfiguration;
            if (nickname) {
console.log(`ready for user to join with known nickname ${nickname}`);
                ui.classList.remove('hidden'); // reveal the join button
                messenger.send('chatReady'); // no extra details
                this.setPreConnectFrameSize();
            } else if (requestName) {
                this.setJoinDialogFrameSize();
                if (window.localStorage) {
                    try {
                        let settings = JSON.parse(window.localStorage.getItem('microverse-settings'));
                        if (!settings || settings.version !== "1") {
                            throw new Error("different version of data");
                        }
                        const oldNick = settings.nickname;
                        const oldAvatarURL = settings.avatarURL;
                        if (oldNick) {
                            const nameField = document.getElementById('nameField');
                            nameField.textContent = oldNick;
                            this.nameFieldChanged();
                        }
                        if (oldAvatarURL) {
                            let predefined = findPredefined(oldAvatarURL);
                            if (predefined) {
                                avatarSelected(predefined);
                            } else {
                                const avatarURLField = document.getElementById('avatarURLField');
                                avatarURLField.textContent = oldAvatarURL;
                                this.avatarURLFieldChanged();
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                joinDialog.classList.remove('hidden');
                populateAvatarSelection();
            } else console.warn("no nickname supplied, and not configured to ask user to enter one");
        } else if (!joinSent && sessionConfiguration.fromLandingPage) {
            // legacy check: only proceed to join if the parent has confirmed (as
            // Greenlight does) that it was started via a landing page.  otherwise
            // let the "click to join" cover go up.  not sure what cases this
            // addresses.
            window.clearTimeout(this.clickEnableTimeoutId);
            joinSession();
        }
    }

    nameFieldKeydown(evt) {
        if (evt.keyCode === 13 || evt.keyCode === 9) evt.preventDefault();
    }

    nameFieldChanged() {
        // first trim start and end whitespace and remove any line feeds that have
        // snuck in.  then replace any non-ascii characters and see if that reduces
        // the length.  if so, show the reduced string
        const nameField = document.getElementById('nameField');
        let value = nameField.textContent.trim().replace(/\r?\n|\r/g, '');
        const beforeFilter = value.length;
        // value = value.replace(/[\u0250-\ue007]/g, '').trim().slice(0,12).trim();
        // const unusable = value.replace(/[\x20-\x7F]/g, '');
        value = value.replace(/[^\x20-\x7F]/g, '').trim().slice(0, 12).trim();
        const div = document.getElementById('nameFilterWarning');
        div.innerHTML = value.length === beforeFilter
            ? '<br/>'
            : `Nickname filtered to "${value}"`;

        const dialogChatButtons = document.getElementById('dialogChatButtons');
        if (value.length >= 1 && value.length <= 12) {
            sessionConfiguration.nickname = value;
            dialogChatButtons.classList.remove('disabled');
        } else {
            dialogChatButtons.classList.add('disabled');
        }
    }

    avatarURLFieldChanged() {
        const avatarURLField = document.getElementById('avatarURLField');
        let value = avatarURLField.textContent.trim();
        avatarSelected({url: value});
    }

    closeDialog() {
        resumeAudioContextIfNeeded(); // make sure to use the click
        const { nickname, avatarURL } = sessionConfiguration;
        joinDialog.classList.add('hidden');
        ui.classList.remove('hidden');
        if (window.localStorage) {
            try {
                let settings = {version: "1", nickname, avatarURL};
                window.localStorage.setItem('microverse-settings', JSON.stringify(settings));
            } catch (e) { /* ignore */ }
        }

        // I think a method called closeDialog() should close the dialog but nothing else
        // sending information should probably be separated.

        messenger.send('chatReady', { nickname });
        parentConnection.sendAvatarURL();

        this.setPreConnectFrameSize();
    }

    dialogCloseJoin() {
        console.log("JOIN");
        this.closeDialog();
        joinSession();
    }

    dialogCloseNoJoin() {
        this.closeDialog();
    }

    onJoinChat(_data) {
        // told by the hosting frame to join
        joinSession();
    }

    onLeaveChat(_data) {
        // told by the hosting frame to leave
        leaveSession();
    }

    onActiveInChat({ inChat }) {
        const elem = document.getElementById('chatCountText'); // only in audioOnly, microverse
        if (elem) {
            elem.textContent = String(inChat.length);
            elem.setAttribute("title", inChat.join("\n"));
        }
    }

    requestInfo() {
        messenger.send('sessionInfoRequest');
        messenger.send('userInfoRequest');
        messenger.send('videoChatInitialStateRequest');
    }

    setJoinDialogFrameSize() {
        let width = 610, height = 610; // default, for a wide screen
        // if a dialog 610px wide wouldn't fit, switch to a narrower one and remove
        // the 'wide' format
        const { innerWidth } = sessionConfiguration;
        if (innerWidth && innerWidth < 630) {
            document.getElementById('joinDialog').classList.remove('wide');
            width = 432;
        }
        messenger.send('setFrameStyle', { left: "50%", top: "50%", width: `${width}px`, height: `${height}px`, transform: "translate(-50%, -50%)" });
    }

    setPreConnectFrameSize() {
        messenger.send('setFrameStyle', { left: "50%", top: "14px", width: "216px", height: "50px", transform: "translate(-116px, 0px)" });
    }

    setConnectedFrameSize() {
        messenger.send('setFrameStyle', { left: "50%", top: "14px", width: "216px", height: "50px", transform: "translate(-116px, 0px)" });
    }

    setSettingsFrameSize() {
        messenger.send('setFrameStyle', { left: "50%", top: "14px", width: "216px", height: "188px", transform: "translate(-116px, 0px)" });
    }

    sendChatJoined() {
        messenger.send('chatJoined');
    }

    sendChatLeft() {
        messenger.send('chatLeft');
    }

    sendAvatarURL() {
        console.log("sending avatar URL");
        messenger.send('setAvatarURL', sessionConfiguration.avatarURL);
    }
}

let parentConnection;
if (window.parent === window) {
    // standalone
    joinSession();
} else {
    // embedded
    parentConnection = new ParentConnection();
}

const logTypes = [ "log", "warn", "error" ];
const prefixes = { log: "", warn: "[w] ", error: "[e] " };
const SystemDate = window.Date;
let logText = "";
function logger(type, msg) {
    // avoid patched Date even if logging from Model code
    const date = new SystemDate();
    // jan 2021: Safari doesn't yet support fractionSecondDigits
    let time = date.toLocaleTimeString('en-US', { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit"}) + "." + ("000" + date.getMilliseconds()).slice(-3) + " ";
    if (msg.startsWith(time.slice(0, 8))) time = "";
    const prefix = prefixes[type];
    logText += `${time}${prefix}${msg}\n`;
}
function installLogger() {
    const cons = window.console;
    const depthOneString = value => {
        // single-level stringification of the value's properties.
        // if it's not a plain object, look at a single level of
        // prototype properties.
        if (value.constructor.name !== "Object") {
            value = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(value))).map(([k, _desc]) => [k, value[k]]).filter(([_k, v]) => typeof v !== "function"));
        }

        return JSON.stringify(Object.fromEntries(Object.entries(value).map(([k, v]) => ([k, String(v)]))));
        };
    logTypes.forEach(type => {
        const nativeFn = cons[`__${type}`] = cons[type];
        cons[type] = (...stuff) => {
            nativeFn(...stuff);
            const argStrings = [];
            stuff.forEach(arg => {
                let argString = "";
                try {
                    // special handling for error objects, since stringify
                    // doesn't do anything helpful.
                    if (arg instanceof Error) argString = arg.stack || arg.message;
                    else if (typeof arg === "object" && arg !== null) {
                        if (arg.constructor.name !== "Object") argString = depthOneString(arg);
                        else {
                            // stringify won't work if object happens to include
                            // circular refs.
                            try {
                                argString = JSON.stringify(arg);
                            } catch (e) {
                                argString = depthOneString(arg);
                            }
                        }
                    } else argString = String(arg);
                    if (argString.length > 500) argString = argString.slice(0, 500) + `...[truncated from ${argString.length} chars]`;
                } catch (e) { argString = `[error in logging: ${e}]`; }
                argStrings.push(argString);
            });
            const msg = argStrings.join(" ");
            logger(type, msg);
            };
    });
}
installLogger();

const previousLogs = [];
function getPreviousLogs() {
    const oldkey = "io.croquet.qChat/log";
    const ourkey = window.location.pathname + "|log";
    try {
        const now = Date.now();
        for (const [key, value] of Object.entries(localStorage)) {
            if (key.startsWith(oldkey)) delete localStorage[key]; // delete old logs
            if (!key.startsWith(ourkey)) continue;
            let [, date] = key.split('|');
            if (now - date > 60 * 60 * 1000) delete localStorage[key]; // delete outdated logs
            else previousLogs.push({...JSON.parse(value), key});
        }
    } catch (_error) { /* ignore */ }
    // store log when user reloads
    window.addEventListener('beforeunload', e => {
        delete e['returnValue']; // let browser unload happen
        try {
            if (!persistentId) return;
            localStorage[`${ourkey}|${Date.now()}`] = JSON.stringify({
                timestamp: Date.now(),
                viewId,
                persistentId,
                log: `Prev: ${sessionId.slice(0, 4)}...\n` + logText.slice(-100000)
            });
        } catch (_error) { /* ignore */ }
    });
}
getPreviousLogs();

let avatars = [
    {png: "f1",
     url: "https://d1a370nemizbjq.cloudfront.net/0725566e-bdc0-40fd-a22f-cc4c333bcb90.glb",
    },
    {png: "f2",
     url: "https://d1a370nemizbjq.cloudfront.net/50ef7f5f-b401-4b47-a8dc-1c4eda1ba8d2.glb",
    },
    {png: "f3",
     url: "https://d1a370nemizbjq.cloudfront.net/b5c04bb2-a1df-4ca4-be2e-fb54799e9030.glb",
    },
    {png: "m1",
     url: "https://d1a370nemizbjq.cloudfront.net/05d16812-01de-48cc-8e06-c6514ba14a77.glb",
    },
    {png: "m2",
     url: "https://d1a370nemizbjq.cloudfront.net/2955d824-31a4-47e1-ba58-6c387c63b660.glb",
    },
    {png: "m3",
     url: "https://d1a370nemizbjq.cloudfront.net/579d4ec8-ade3-49ea-8b52-2ea5fe097f7d.glb"
    }
];

function avatarSelected(entry) {
    sessionConfiguration.avatarURL = entry.url;

    let holder = document.querySelector("#avatarList");
    for (let i = 0; i < holder.childNodes.length; i++) {
        let child = holder.childNodes[i];
        if (child.getAttribute("avatarURL") === entry.url) {
            child.setAttribute("selected", true);
        } else {
            child.removeAttribute("selected");
        }
    }

    const avatarURLField = document.getElementById('avatarURLField');
    let value = avatarURLField.textContent.trim();
    if (value !== entry.url) {
        avatarURLField.textContent = "";
    }
}

function findPredefined(url) {
    return avatars.find((entry) => entry.url === url);
}

function populateAvatarSelection() {
    let holder = document.querySelector("#avatarList");

    avatars.forEach((entry) => {
        let div = document.createElement("div");
        div.classList.add("avatarThumb");
        div.onclick = () => avatarSelected(entry);
        div.style.backgroundImage = `url(./assets/avatars/${entry.png}.png)`;
        div.setAttribute("avatarURL", entry.url);
        holder.appendChild(div);
    });
}
