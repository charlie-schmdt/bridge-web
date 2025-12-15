import { CallStatus, Exit, IceCandidate, Join, PeerExit, PeerScreenShare, PeerScreenShareStop, SdpAnswer, SdpOffer, SignalMessage, SignalMessageType } from "@/renderer/types/roomTypes";
import { WebSocketURL } from "@/utils/endpoints";
import { validate as isValidUUID } from "uuid";

// Define React callbacks for the RoomFeed renderer to provide
export interface RoomConnectionManagerCallbacks {
  onStatusChange: (status: CallStatus) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteStreamStopped: () => void;
  onPeerExit: (peerId: string, peerName: string) => void;
  onPeerScreenShare: (peerId: string, stream: MediaStream) => void;
  onPeerScreenShareStopped: (peerId: string) => void;
  onError: (message: string) => void;
}

export class RoomConnectionManager {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;

  private roomId: string;
  private clientId: string;
  private userName: string;
  private callbacks: RoomConnectionManagerCallbacks;

  private screenShareVideoTransceiver: RTCRtpTransceiver | null = null;
  private screenShareAudioTransceiver: RTCRtpTransceiver | null = null;

  // Internal state
  private exited = true;

  // streamId -> MediaStream
  private pendingStreams: Map<string, MediaStream> = new Map();
  // streamId -> peerId
  private pendingScreenShareIds: Map<string, string> = new Map();

  constructor(
    roomId: string,
    clientId: string,
    userName: string,
    callbacks: RoomConnectionManagerCallbacks
  ) {
    this.roomId = roomId;
    this.clientId = clientId;
    this.userName = userName;
    this.callbacks = callbacks;
  }

  public initSignalingConnection(): void {
    this.ws = new WebSocket(WebSocketURL);
    this.exited = true;

    // Register websocket handlers
    this.ws.onopen = () => {
      console.log("WebSocket connected.");
    };
    
    this.ws.onmessage = (event: MessageEvent) => {
      // Default handler for before webRTC connection is activated
      console.log("WS msg (webrtc inactive): ", JSON.parse(event.data));
    };

    this.ws.onclose = () => {
      console.log("WebSocket disconnected");
      this.disconnect();
    }

    this.ws.onerror = (err) => {
      console.error("Websocket error: ", err);
      this.callbacks.onError("Signaling server connection failed");
    };
  }

  public async connect(localStream: MediaStream): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onError("Signaling server not connected");
      return;
    }
    
    this.exited = false;

    try {
      this.pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "stun:stun.l.google.com"
          }
        ]
      });

      this.pc.addTrack(localStream.getVideoTracks()[0], localStream);
      this.pc.addTrack(localStream.getAudioTracks()[0], localStream);

      this.pc.onicecandidate = this.handleIceCandidate;
      this.pc.onconnectionstatechange = this.handleConnectionStateChange;
      this.pc.ontrack = this.handleTrack;

      this.ws.onmessage = this.handleWsMessage;
    
      const namePayload: Join = { name: this.userName };
      this.sendMessage("join", namePayload);
    } catch (err) {
      console.error("Error during connection setup:", err);
      this.callbacks.onError("Failed to start call");
      this.disconnect();
    }
  }

  public async startScreenShare(stream: MediaStream): Promise<void> {
    if (!this.screenShareVideoTransceiver) {
      console.error("No screen share video transceiver available");
      return;
    }
    const screenTrack = stream.getVideoTracks()[0];
    if ("contentHint" in screenTrack) {
      screenTrack.contentHint = "detail";
    }
    await this.screenShareVideoTransceiver.sender.replaceTrack(screenTrack);
    try {
      const params = this.screenShareVideoTransceiver.sender.getParameters();
      params.degradationPreference = "maintain-resolution";
      await this.screenShareVideoTransceiver.sender.setParameters(params);
      console.log("Screen share configured for high resolution");
    }
    catch (err) {
      console.log("Failed to get screen share encoding parameters");
    }
    //this.pc.addTrack(stream.getVideoTracks()[0], stream);
    this.sendMessage("screenShareRequest", {});
  }

  public stopScreenShare(streamId: string): void {
    this.sendMessage("peerScreenShareStop", { streamId });
  }

  public disconnect(): void {
    if (this.exited) {
      return; // Already disconnected
    }
    console.log("Disconnecting...");
    this.exited = true;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload: Exit = { peerName: this.userName };
      this.sendMessage("exit", payload);
    }

    // Reset the message handler to just print the message
    if (this.ws) {
      this.ws.onmessage = (event: MessageEvent) => {
        console.log("WS msg (inactive): ", JSON.parse(event.data))
      };
    }

    // Reset PeerConnection handlers to do nothing
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.onnegotiationneeded = null;
      this.pc.close();
      this.pc = null;
    }

    this.callbacks.onStatusChange("inactive");
    this.callbacks.onRemoteStreamStopped();

    // NOTE: don't disconnect the signaling WebSocket until component is unmounted
  }

  public cleanup(): void {
    // For component unmounting
    this.disconnect(); // In case it wasn't called already (idempotent)
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect if exists
      this.ws.close();
      this.ws = null
    }
  }

  private handleIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      this.sendMessage("candidate", event.candidate);
    }
    else {
      console.log("Received invalid ICE candidate event: ", event);
    }
  }

  private handleConnectionStateChange = () => {
    if (!this.pc) return;

    console.log("PC Connection update: ", this.pc.connectionState);
    switch (this.pc.connectionState) {
      case "connected":
        this.callbacks.onStatusChange("active");
        break;
      case "disconnected":
      case "failed":
      case "closed":
        this.disconnect(); // Trigger PC disconnect (keep signaling WebSocket open)
        break;
    }
  }

  private handleTrack = (event: RTCTrackEvent) => {
    console.log("Received remote track event: ", event);
    const remoteStream = event.streams[0];
    if (!remoteStream) {
      return;
    }
    if (this.pendingScreenShareIds.has(remoteStream.id)) {
      this.callbacks.onPeerScreenShare(this.pendingScreenShareIds.get(remoteStream.id), remoteStream);
      this.pendingScreenShareIds.delete(remoteStream.id)
    }
    else {
      // Check if stream ID is a valid uuid
      if (isValidUUID(remoteStream.id)) {
        // Peer ID, call remote stream callback
        this.callbacks.onRemoteStream(remoteStream);
      }
      else if (remoteStream.id.includes("screen")) {
        // Assume screen share, add to pending screen shares
        this.pendingStreams.set(remoteStream.id, remoteStream);
      }
      else {
        console.warn("Received remote stream with unrecognized ID: ", remoteStream.id);
      }
    }

    // Request a key frame to start decoding video frames
    this.sendMessage("pli", {})
  }

  // This will run when adding a new track 
  private handleNegotiationNeeded = async () => {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendMessage("offer", this.pc.localDescription);
    } catch (err) {
      console.error("Error during negotiationneeded handling: ", err);
    }
  }

  private handleWsMessage = async (event: MessageEvent) => {
    if (!this.pc) return;

    const msg: SignalMessage = JSON.parse(event.data);
    console.log("msg (call active): ", msg);

    try {
      switch (msg.type) {
        case "offer":
          const offer = msg.payload as SdpOffer;
          await this.pc.setRemoteDescription(new RTCSessionDescription({type: "offer", sdp: offer.sdp}));

          // Find and store screen share transceivers
          const transceivers = this.pc.getTransceivers();
          if (transceivers.length >= 4) {
            this.screenShareVideoTransceiver = transceivers[2];
            this.screenShareAudioTransceiver = transceivers[3];
            this.screenShareAudioTransceiver.direction = "sendonly";
            this.screenShareVideoTransceiver.direction = "sendonly";
          }
          else {
            console.warn(`Expected at least 4 transceivers, found ${transceivers.length}, no screen share transceivers stored`);
          }

          const ans = await this.pc.createAnswer();
          await this.pc.setLocalDescription(ans);
          this.sendMessage("answer", this.pc.localDescription)
          // After setting remote description, set the handler for onnegotiationneeded
          this.pc.onnegotiationneeded = this.handleNegotiationNeeded;
          break;
        case "answer":
          const answer = msg.payload as SdpAnswer;
          await this.pc.setRemoteDescription(new RTCSessionDescription({type: "answer", sdp: answer.sdp}));
          break;
        case "candidate":
          const candidate = msg.payload as IceCandidate;
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          break;
        case "peerExit":
          const peerExit = msg.payload as PeerExit;
          this.callbacks.onPeerExit(peerExit.peerId, peerExit.peerName);
          this.callbacks.onRemoteStreamStopped();
          break;
        case "peerScreenShare":
          const peerScreenShare = msg.payload as PeerScreenShare;
          // Check if we have the stream already
          if (this.pendingStreams.has(peerScreenShare.streamId)) {
            const screenStream = this.pendingStreams.get(peerScreenShare.streamId);
            this.pendingStreams.delete(peerScreenShare.streamId);
            this.callbacks.onPeerScreenShare(peerScreenShare.peerId, screenStream!);
          }
          else {
            // Add to pending screen share ids
            this.pendingScreenShareIds.set(peerScreenShare.streamId, peerScreenShare.peerId);
          }
          break;
        case "peerScreenShareStop":
          const peerScreenShareStop = msg.payload as PeerScreenShareStop;
          if (this.pendingStreams.has(peerScreenShareStop.peerId)) {
            this.pendingStreams.delete(peerScreenShareStop.peerId);
          }
          else if (this.pendingScreenShareIds.has(peerScreenShareStop.peerId)) {
            this.pendingScreenShareIds.delete(peerScreenShareStop.peerId);
          }
          else {
            this.callbacks.onPeerScreenShareStopped(peerScreenShareStop.peerId);
          }
          break;
        default:
          console.warn("Unhandled WS message type: ", msg.type);
          break;
      }
    } catch (err) {
      console.error("Error in WS message handler: ", err);
    }
  };

  private sendMessage(type: SignalMessageType, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("Cannot send message, WebSocket is not available. Type: ", type);
      return;
    }
    const msg: SignalMessage = {
      type,
      clientId: this.clientId,
      roomId: this.roomId,
      payload
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`Failed to send WebSocket message (Type: ${type}):`, err);
    }
  }
}
