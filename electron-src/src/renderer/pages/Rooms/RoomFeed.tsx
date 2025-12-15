import { Button } from '@/renderer/components/ui/Button';
import WaitingRoom from '@/renderer/components/WaitingRoom';
import { supabase } from '@/renderer/lib/supabase';
import { CallStatus, VideoLayout } from '@/renderer/types/roomTypes';
import { Endpoints } from '@/utils/endpoints';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { v4 as uuid } from 'uuid';
import { useAuth } from '../../contexts/AuthContext';
import { RoomConnectionManager, RoomConnectionManagerCallbacks } from './RoomConnectionManager';
import { useRoomMediaContext } from './RoomMediaContext';
import { RoomSettingsFooter } from './RoomSettingsFooter';
import { ScreenSelector } from './ScreenSelector';
import { VideoGrid } from './VideoGrid';

export interface RoomFeedProps {
  roomId: string | undefined;
  updateAttendeeId: (data: string) => void;

}

export function RoomFeed({roomId, updateAttendeeId}: RoomFeedProps) {
  const { user } = useAuth()
  const localRoomMedia = useRoomMediaContext();

  const [callStatus, setCallStatus] = useState<CallStatus>("inactive");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const [screenShare, setScreenShare] = useState<{ stream: MediaStream, peerId: string } | null>(null);
  // map streamId/peerId (implemented as the same in the SFU) to its MediaStream
  const [remoteStreams, setRemoteStreams] = useState<Map<String, MediaStream>>(new Map());
  const [isAdmitted, setIsAdmitted] = useState(false);
  const [userRole, setUserRole] = useState("");

  const [isScreenSelectorOpen, setIsScreenSelectorOpen] = useState(false);
  const [screenIsShared, setScreenIsShared] = useState(false);
  const [currentLayout, setCurrentLayout] = useState<VideoLayout>("grid");
  const [speakerLayoutOverride, setSpeakerLayoutOverride] = useState<boolean>(false);

  const roomConnectionManagerRef = useRef<RoomConnectionManager | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  // Synchronous means of checking if room is active or has been exited
  const clientId = useRef<string>(uuid());

  const remoteStreamRef = useRef<MediaStream | null>(null);

  const effectiveRoomId = roomId || "testroom";

  const cleanUpRoomExit = async () => {
    try {//Remove user from room on unmount
      const token = localStorage.getItem("bridge_token");
      console.log("TRYING TO REMOVE: ", Endpoints.ROOMS, "/removeRoomMember", roomId )
      const response = await fetch(`${Endpoints.ROOMS}/removeRoomMember/${roomId}`, {
        method: "PUT",
        headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          uuid: user.id
        }),
      }).then((response) => response.json())
      .then((data) => {
        console.log("✅ ROOM MEMBER REMOVED SUCCESFULLY:", data)

      })
    } catch (error) {
      console.error("Error updating members:", error);
      alert("Failed to update members");
    }
  };
  const getUserRole = async () => {
    try {
        const token = localStorage.getItem("bridge_token");
        const response = await fetch(`${Endpoints.ROOMS}/getRoom/${roomId}`, {
          headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
        });
        if (!response.ok) {
          throw new Error("Failed to fetch user room");
        }
        const data = await response.json();
        console.log("📣 Fetched room data: ", data);
        const room_data = data.room;
        const isHost = (room_data.created_by === user.id);
        

        if (isHost) {
          setUserRole("Host");
        }
        else {
          setUserRole("Member");
        }

      } catch (error) {
        console.error("Error fetching room: " , error);
      }
  };

  console.log("RENDERING ROOMFEED FOR ROOM " + effectiveRoomId);

  useEffect(() => {
    getUserRole();
    console.log("ROOM FEED CHANNEL STARTED")
    const channel = supabase.channel("room-feed-members")
    .on("postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "rooms",
      },
      async (payload) => {
        if (payload.eventType === "UPDATE") {
          console.log("UPDATING ROOM MEMBERS ");
          const updated_RM = payload.new.room_members;
          const user_entry = updated_RM.find(entry => (entry.uuid===user.id));
          if (user_entry) {
            const curr_state = user_entry.state;
            if (curr_state === "user_admitted") {
              joinRoom();
              
              console.log("ADMITTING USER");
            }
          }
        }
      }
    )
    .subscribe();
  
    return () => {
      supabase.removeChannel(channel);
      cleanUpRoomExit();

    };
  }, [])
    

  // Initiate the WebSocket connection with the Node server
  // NOTE: This is NOT the WebRTC stream for video/audio, so it has the same lifetime as the component
  useEffect(() => {
    console.log("UUID: ", clientId);
    // Define callbacks used by the roomConnectionManager to update state
    const callbacks: RoomConnectionManagerCallbacks = {
      onStatusChange: (status: CallStatus) => setCallStatus(status),
      onRemoteStream: (stream: MediaStream) => {
        // New track received, update remoteStreams accordingly
        console.log("My stream", stream)
        setRemoteStreams(prevRemoteStreams => {
          console.log("got stream id: " + stream.id);
          if (prevRemoteStreams.has(stream.id)) {
            // Stream already exists, browser instance should automatically add it to the stream
            return prevRemoteStreams;
          }
          else {
            // Add new stream to remoteStreams
            const newRemoteStreams = new Map(prevRemoteStreams);
            newRemoteStreams.set(stream.id, stream);
            return newRemoteStreams;
          }
        });
      },
      onRemoteStreamStopped: () => {
        // leave for now
      },
      onPeerExit: (peerId, peerName) => {
        // Close remote stream if the ref still holds tracks
        setRemoteStreams(prevRemoteStreams => {
          if (prevRemoteStreams.has(peerId)) {
            prevRemoteStreams.get(peerId).getTracks().forEach(track => track.stop());
            prevRemoteStreams.delete(peerId)
            const newRemoteStreams = new Map(prevRemoteStreams);
            toast(`${peerName} has left the room`);
            console.log(newRemoteStreams);
            return newRemoteStreams;
          }
          else {
            // Stream does not exist for the peerID
            console.error(`Stream does not exist for peer ${peerName} with id ${peerId}`);
            return prevRemoteStreams;
          }
        });
      },
      onPeerScreenShare: (peerId, stream) => {
        toast(`${peerId} has started screen sharing`);
        setSpeakerLayoutOverride(true);
        setScreenShare(prevScreenShare => {
          if (prevScreenShare && prevScreenShare.stream) {
            prevScreenShare.stream.getTracks().forEach(track => track.stop());
          }
          return { stream: stream, peerId: peerId };
        });
      },
      onPeerScreenShareStopped: (peerId) => {
        toast(`${peerId} has stopped screen sharing`);
        setSpeakerLayoutOverride(false);
        setScreenShare(prevScreenShare => {
          if (!prevScreenShare) {
            console.error("No active screen share to stop");
            return null;
          }
          if (prevScreenShare.peerId !== peerId) {
            console.error("Screen share peerId does not match active screen share");
            return prevScreenShare;
          }
          if (prevScreenShare.stream) {
            prevScreenShare.stream.getTracks().forEach(track => track.stop());
          }
          return null;
        });
      },
      onError: (message) => toast.error(message),
    };

    // Instantiate the connection manager
    const manager = new RoomConnectionManager(
      effectiveRoomId,
      clientId.current,
      user.name,
      callbacks
    );
    manager.initSignalingConnection(); // Start the WebSocket connection
    roomConnectionManagerRef.current = manager;

    // Return cleanup function to run on unmount
    return () => {
      exitRoom().then(() => {
        console.log("Cleaning up connection manager...");
        manager.cleanup(); // This will disconnect and close the WebSocket
        roomConnectionManagerRef.current = null;
      });
    }
  }, []); // Run only once on mount

  // Toggle camera
  useEffect(() => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
      console.log("Changing videoTrack to: " + localRoomMedia.isVideoEnabled);
      videoTrack.enabled = localRoomMedia.isVideoEnabled;
    }
  }, [localStream, localRoomMedia.isVideoEnabled]);

  // Toggle microphone
  useEffect(() => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      console.log("Changing audioTrack to: " + localRoomMedia.isAudioEnabled);
      audioTrack.enabled = localRoomMedia.isAudioEnabled;
    }
  }, [localStream, localRoomMedia.isAudioEnabled])

  // Handle local video component changes
  useEffect(() => {
    if (!localRoomMedia.videoRef.current) {
      // Ref points to nothing yet, do nothing
      return;
    }

    if (localStream) {
      if (localRoomMedia.videoRef.current.srcObject !== localStream) {
        localRoomMedia.videoRef.current.srcObject = localStream;
        localRoomMedia.videoRef.current.play()
          .then(_ => {
            console.log("Playing local stream");
          })
          .catch(error => {
            if (error.name === 'NotAllowedError') {
              console.error("Autoplay was prevented. User must interact with the page")
            }
            else if (error.name !== 'AbortError') { // AbortError occurs on unmount
              console.error("Video play() failed:", error);
            }
          });
      }
    }
    else {
      // localStream is null, remove video reference
      console.log("Local stream is null, clearing srcObject");
      localRoomMedia.videoRef.current.srcObject = null;
    }
  }, [localRoomMedia.videoRef, localStream]) // videoRef inclusion does nothing, satisfies ESLint

  const initMedia = async (): Promise<MediaStream | null> => {
    try {
      // Get video stream
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      newStream.getVideoTracks().forEach(t => (t.enabled = localRoomMedia.isVideoEnabled));
      newStream.getAudioTracks().forEach(t => (t.enabled = localRoomMedia.isAudioEnabled));
      setLocalStream(newStream);
      return newStream;
    } catch (err) {
      console.error("Error accessing camera: ", err);
      toast.error("Could not access camera and/or microphone");
      return null;
    }
  };

  const joinRoom = async () => {
    setCallStatus("loading");
    const manager = roomConnectionManagerRef.current;
    if (!manager) {
      toast.error("Connection not ready or microphone not available");
      return;
    }

    const stream = localStream || (await initMedia());
    if (!stream) {
      console.error("Error starting local media");
      toast.error("Could not start local media");
      return;
    }

    // Initiate P2P connection with the SFU
    await manager.connect(stream);
  };

  const updateRoomForSession = async (roomId, sessionId) => {
    console.log("Updating room for session ", sessionId)
            try {
            const token = localStorage.getItem("bridge_token");
            const response = await fetch(`${Endpoints.ROOMS}/startSessionInRoom/${roomId}`, {
                method: "PUT",
                headers: {
                'Authorization': `Bearer ${token}`,
                "Content-Type": "application/json",
                },
                body:  JSON.stringify({
                  session_id: sessionId
                })
            });
            const data = await response.json();
            if (data.success) {
                console.log("✅ Updated to session successfully:", data);
            } else {

            }
        } catch (error) {
            console.log("ERROR: ",error)
        }
    
  }
  const hostStartCall = async () => {
    joinRoom();
    const session_id = await hostStartSession(roomId);
    await updateRoomForSession(roomId, session_id)
    
    /*
      TODO: Host starting call tasks
    */
  };

  const exitRoom = async () => {
    roomConnectionManagerRef.current?.disconnect();

    // Stop and clear remote media
    setRemoteStreams(prevRemoteStreams => {
      Array.from(prevRemoteStreams.values()).forEach(stream => stream.getTracks().forEach(track => track.stop()));
      return new Map();
    });

    // Stop and clear local media
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    if (screenShare && screenShare.stream) {
      screenShare.stream.getTracks().forEach(track => track.stop());
      setScreenShare(null);
    }

    setCallStatus("inactive");
  };

  const handleScreenSelected = async (stream: MediaStream) => {
    if (stream) {
      if (roomConnectionManagerRef.current) {
        roomConnectionManagerRef.current.startScreenShare(stream);
      }
      setScreenShare({ stream: stream, peerId: clientId.current });
      setScreenIsShared(true);
      setSpeakerLayoutOverride(true);
      toast("Sharing screen");
    }
    else {
      toast.error("Could not access screen for sharing");
    }
    setIsScreenSelectorOpen(false);
  };

  const handleCancelScreenSelect = () => {
    setIsScreenSelectorOpen(false);
  }
  
  const stopShare = () => {
    setScreenShare(prevScreenShare => {
      if (prevScreenShare && prevScreenShare.stream) {
        prevScreenShare.stream.getTracks().forEach(track => track.stop());
        if (roomConnectionManagerRef.current) {
          roomConnectionManagerRef.current.stopScreenShare(clientId.current);
        }
        toast("Stopped sharing screen");
        setSpeakerLayoutOverride(false);
      }
      else {
        console.error("No screen stream to stop");
      }
      return null;
    });
    setScreenIsShared(false);
  }

  const shareScreen = () => {
    setIsScreenSelectorOpen(true);
  };

  const toggleView = () => {
    setCurrentLayout((currentLayout) => {
      if (currentLayout == "speaker") {
        return "grid";
      }
      else {
        return "speaker";
      }
    })
  }

  const allStreams = useMemo(() => {
    const streams = [];
    if (localStream) {
      // The local video is always muted for the user to avoid feedback
      streams.push({ stream: localStream, isMuted: false });
    }
    Array.from(remoteStreams.values()).forEach(stream => {
      // Remote streams are not muted
      streams.push({ stream, isMuted: false });
    });
    return streams;
  }, [localStream, screenShare, remoteStreams]);

  const hostStartSession = async (roomId) => {
    try {
        const token = localStorage.getItem("bridge_token");
        const response = await fetch(`${Endpoints.SESSIONS}/createSession/${roomId}`, {
            method: "POST",
            headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            },
            body:  JSON.stringify({
                
            })
        });
        const data = await response.json();
        if (data.success) {
            console.log("✅ Session started successfully:", data.session);
            return data.session.id;
        } else {

        }
    } catch (error) {
        console.log("ERROR: ",error)
                
    }
  };





  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-0">
      {isScreenSelectorOpen && (
        <ScreenSelector
          onScreenSelected={handleScreenSelected}
          onCancel={handleCancelScreenSelect}
          isOpen={isScreenSelectorOpen}
        />
      )}
      { callStatus === "inactive" ? (
          <div className="flex-1 w-full min-h-0 grid place-items-center">

          {/*
            TODO:
              Host option to start room instead of default waiting room
          */}

          {!isAdmitted && (
            <WaitingRoom 
            room_id={roomId}
            callStatus={callStatus}
            updateAttId={updateAttendeeId}
          />)}
          {userRole==="Host" && <Button color="primary" onPress={hostStartCall}>Start Call</Button>}
          {/*<Button color="primary" onPress={joinRoom}>(BYPASS ADMITTED) Join Call</Button>*/}
        </div>
      )
        :
      (
        <>
          <div className="flex-1 w-full min-h-0">
            <VideoGrid
              layout={speakerLayoutOverride ? "speaker" : currentLayout}
              streams={allStreams}
              screenStream={{stream: screenShare?.stream, isMuted: true}}
            />
          </div>
          <RoomSettingsFooter
            roomId={roomId}
            onLeave={exitRoom}
            screenIsShared={screenIsShared}
            onShare={shareScreen}
            stopShare={stopShare}
            toggleView={toggleView}
          />
        </>
      )}
    </div>
  );
}
