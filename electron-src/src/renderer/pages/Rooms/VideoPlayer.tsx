import { useEffect, useRef } from "react";

export interface VideoPlayerProps {
  stream: MediaStream;
  isMuted?: boolean;
}

export const VideoPlayer = ({ stream, isMuted = false }: VideoPlayerProps) => {

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      // Assign the stream to the videoElement's srcObject
      videoRef.current.srcObject = stream;
    }
  }, [stream])

  return (
    // The parent div in the grid will handle sizing, spacing, and rounding.
    <video ref={videoRef} autoPlay playsInline muted={isMuted} className="w-full h-full object-cover" />
  );
}
