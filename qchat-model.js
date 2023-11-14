/* eslint-disable nonblock-statement-body-position */
/* global Croquet */

class QChatModel extends Croquet.Model {
    init() {
        super.init();

        this.peerDict = {};
        this.lastPeerIndex = -1;
        this.peerLogs = [];

        // a peer announcing its arrival in the session (after initialising its Agora client)
        this.subscribe(this.sessionId, 'peer-details', this.onChatPeerDetails);
        this.subscribe(this.sessionId, 'peer-intended-state', this.onPeerIntendedState);

        this.subscribe(this.sessionId, 'peer-track-subscriptions', this.onPeerTrackSubscriptions);

        this.solo = true;
        this.subscribe(this.sessionId, 'set-solo', this.onSetSolo);

        this.subscribe(this.sessionId, 'peer-hand', this.onPeerHand);

        this.activePeer = null;
        this.subscribe(this.sessionId, 'set-active-peer', this.onSetActivePeer);
        this.subscribe(this.sessionId, 'remove-active-peer', this.onRemoveActivePeer);

        this.subscribe(this.sessionId, 'mute-peer-audio', this.mutePeerAudio);

        this.subscribe(this.sessionId, 'view-join', this.onViewJoin);
        this.subscribe(this.sessionId, 'view-exit', this.onViewExit);

        this.subscribe(this.sessionId, 'gather-logs', this.gatherLogs);
        this.subscribe(this.sessionId, 'peer-log', this.receiveLog);

        this.VERSION_NONCE = 0;
    }

    allPeerIds() { return Object.keys(this.peerDict); }
    filteredPeerIds(fn) { return this.allPeerIds().filter(viewId => fn(this.peerDict[viewId])); }
    identifiedPeers() { return this.filteredPeerIds(peer => peer.viewColor); }
    // has the peer been seen?  once true for a given peer, this will only be reset
    // if the peer leaves and doesn't come back in 24 hours of teatime.
    hasPeer(viewId) { return !!this.peerDict[viewId]; }
    // is the peer currently in the session?  (i.e., post view-join)
    hasJoinedPeer(viewId) {
        const peer = this.peerDict[viewId];
        return !!(peer && peer.joined);
    }
    // has the peer's ChatManager supplied the user details?
    hasIdentifiedPeer(viewId) {
        const peer = this.peerDict[viewId];
        return !!(peer && peer.viewColor);
    }

    peerSnapshotForId(viewId) {
        const peer = this.peerDict[viewId];
        if (!peer) return null;

        // deep clone, to protect the model
        const snap = { ...peer };
        // aug 2022: subscribed is now an object: viewId => ["a", "v"]
        const newSub = {};
        if (snap.subscribed) {
            for (const [k, v] of Object.entries(snap.subscribed)) newSub[k] = [...v];
        }
        snap.subscribed = newSub;
        delete snap.joined; // taken for granted
        return snap;
    }

    onViewJoin(viewId) {
        // the first join by a given croquet view causes creation
        // of a stub peer record.  the view will publish a
        // chatPeerJoin event in due course, providing name and
        // other details.
        // for a view that leaves the croquet session we null out
        // all but the peer index, which is reused if the view
        // re-joins.  even if the view is never seen again, it's
        // a trivial record to keep.
        // jun 2022: when the model code is stable, those records do
        // rather build up.  so make a note of the teatime at which a
        // peer leaves, and on each restart of the session (first peer
        // to join) do some housekeeping to clear out peers that left
        // more than 24 hours of teatime ago.
        if (this.hasJoinedPeer(viewId)) {
            throw Error("joining view is already known");
        }

        if (!this.hasPeer(viewId)) {
            // keep incrementing peer index, so the latest to arrive
            // will appear last in the peers display.
            const peerIndex = ++this.lastPeerIndex;
            this.peerDict[viewId] = { peerIndex };
        }

        // because peer records stay in the model even if the view
        // leaves, we need our own flag to indicate whether a view
        // is currently in the session or not.
        this.peerDict[viewId].joined = true;
        delete this.peerDict[viewId].exitTime;

        if (this.viewCount === 1) this.clearOldExitedPeers();
    }

    onViewExit(viewId) {
        // the only way a peer will be removed from the list is
        // here, the handler for view-exit.
        // NB: being removed from the croquet session does not
        // directly imply removal from the chat; if the peer is
        // still connected through Agora, they will remain in the
        // chat unless/until they also leave Agora.
        const peer = this.peerDict[viewId];
        // keep just the peerIndex and exit time, as explained above.
        this.peerDict[viewId] = { peerIndex: peer.peerIndex, exitTime: this.now() };

        if (peer.raisingHand) this.onPeerHand({ viewId, raisingHand: false });
        this.publish(this.sessionId, 'on-peer-exit', viewId);
    }

    clearOldExitedPeers() {
        const MAX_UNSEEN_MS = 24 * 60 * 60 * 1000; // one day of teatime
        const now = this.now();
        this.filteredPeerIds(peer => peer.exitTime && now - peer.exitTime > MAX_UNSEEN_MS).forEach(id => {
                console.log(`forgetting long-lost peer ${id}`);
                delete this.peerDict[id];
            });
    }

    onChatPeerDetails({ viewId, nickname, initials, viewColor, agent, rejoining }) {
        // a view has published 'peer-details' to announce its
        // identification (nickname etc) for the chat.
        // as of jan 2021 the view also sends its user-agent string -
        // which we use only for logging to the console, but must
        // store in the model so that latecomers get to see the
        // details for everyone already in the call.
        const peer = this.peerDict[viewId];
        if (!peer) {
            console.error(`failed to find peer record to assign details for ${viewId}`);
        } else {
            Object.assign(peer, { nickname, initials, viewColor, agent });
            this.publish(this.sessionId, 'on-peer-details', viewId);

            // if this brings the number of peers to 3, ensure that the views
            // are not in solo (so everyone is visible) and - unless the new
            // arrival is just rejoining after a session glitch - set them as
            // the active peer.
            const numPeers = this.identifiedPeers().length;
            if (numPeers === 3) {
                this.onSetSolo(false);
                if (!rejoining) this.onSetActivePeer(viewId, true); // and publish
            } else if (numPeers === 1) {
                // june 2021: make sure that the first peer to join is in solo mode
                // (see comment in qchat-app's removePeer() on how solo can be wrong)
                if (!this.solo) console.log("ensuring solo mode as first peer");
                this.onSetSolo(true);
            }
        }
    }

    onPeerIntendedState(data) {
        if (this.hasIdentifiedPeer(data.viewId))
            this.publish(this.sessionId, 'on-peer-intended-state', data);
    }

    onSetSolo(solo) {
        if (solo === this.solo) return;

        this.solo = solo;
        this.publish(this.sessionId, 'update-solo', solo);
    }

    onPeerTrackSubscriptions({viewId, subscribed}) {
        const peer = this.peerDict[viewId];
        if (peer) {
            peer.subscribed = subscribed;
            this.publish(this.sessionId, 'on-peer-track-subscriptions', { viewId, subscribed });
        }
    }

    // NOT USED
    mutePeerAudio(viewId) {
        const peer = this.peerDict[viewId];
        if (peer) {
            this.publish(viewId, 'mute-audio');
        }
    }

    onSetActivePeer(viewIdOrNull, publish = true) {
        // handling of event from a peer requesting to be the
        // active peer, or a call within the model (in which case
        // the publish argument is specified).
        if (viewIdOrNull && !this.peerDict[viewIdOrNull]) return; // can't be active if it's not there

        this.activePeer = viewIdOrNull;
        if (publish) this.publishActivePeer();
    }

    onRemoveActivePeer(viewId) {
        // a provisional removal, triggered by a remove-active-peer
        // from the peer in question.  iff it is still the active
        // one, clear it.
        if (this.activePeer !== viewId) return;

        this.activePeer = null;
        this.publishActivePeer();
    }

    publishActivePeer() {
        // change no sooner than DELAY ms after the last change
        const DELAY = 1000;
        const now = this.now();
        const last = this.lastActivePeerPublish || -1;
        const next = this.nextActivePeerPublish || -1;

        // if a future time is already recorded (and is still in
        // the future), nothing needs to be done.
        if (next > now) return;

        if (next === now) {
            // filter out additional calls that arrive at exactly the
            // recorded "next" time (unlikely, but...) by noticing
            // that the "last" time is already the same.
            if (next === last) return;
        } else {
            // if too soon to publish, record the first time that
            // will be ok, and set up a future message for that time.
            const timeToNext = DELAY - (now - last);
            if (timeToNext > 0) {
                this.nextActivePeerPublish = now + timeToNext;
                this.future(timeToNext).publishActivePeer();
                return;
            }
        }
        // go ahead with the publish (using the latest value of
        // activePeer), and record the time.
        this.lastActivePeerPublish = now;
        this.publish(this.sessionId, 'update-active-peer', this.activePeer);
    }

    onPeerHand({ viewId, raisingHand }) {
        const peer = this.peerDict[viewId];
        if (peer) {
            peer.raisingHand = raisingHand;
            this.publish(this.sessionId, 'on-peer-hand', { viewId, raisingHand });
        }
    }

    gatherLogs(data) {
        // gather logs from everyone (apart from the initiating view)
        // who hasn't sent a log in the last minute.
        this.publish(this.sessionId, 'on-gather-logs', data);
    }

    receiveLog(data) {
        if (this.peerLogs.length > 100) this.peerLogs.shift();
        this.peerLogs.push(data);
        this.publish(this.sessionId, 'on-peer-log', data);
    }
}
QChatModel.register("QChatModel");
window.QChatModel = QChatModel;
