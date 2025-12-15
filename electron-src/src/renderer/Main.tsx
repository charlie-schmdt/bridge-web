import { AppLayout } from "@/renderer/AppLayout";
import { ToastProvider } from "@heroui/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";
import "../index.css";
import AuthCallback from "./AuthCallback";
import { ProtectedRoute } from "./components/ProtectedRoute";
import TestWaitingRoomCall from "./components/TestWaitingRoomCall";
import { AudioContextProvider } from "./contexts/AudioContext";
import { AuthProvider } from "./contexts/AuthContext";
import LogInLayout from "./LogInLayout";
import OnboardingLayout from "./OnboardingLayout";
import FAQLayout from "./pages/FAQ/FAQLayout";
import { HomeLayout, homeLoader } from "./pages/Home/HomeLayout";
import { RoomLayout } from "./pages/Rooms/RoomLayout";
import { WorkspaceLayout } from "./pages/Workpaces/WorkspaceLayout";
import { ProfileLayout } from "./ProfileLayout";
import { SettingsLayout } from "./SettingsLayout";

const router = createHashRouter([
  {
    path: "/login",
    element: <LogInLayout />,
  },
  {
    path: "faq",
    element: <FAQLayout />,
  },
  {
    path: "auth/callback",
    element: <AuthCallback />,
  },
  {
    path: "/",
    element: (
      <ProtectedRoute>
        <AppLayout />
      </ProtectedRoute>
    ),
    children: [
      {
        // Default protected route goes to home
        index: true,
        loader: homeLoader,
        element: <HomeLayout />,
      },
      {
        path: "onboarding",
        element: <OnboardingLayout />,
      },
      {
        path: "profile",
        element: <ProfileLayout />,
      },
      {
        path: "profile/:userId",
        element: <ProfileLayout />,
      },
      {
        path: "settings",
        element: <SettingsLayout />,
      },
      {
        path: "room",
        element: <RoomLayout />,
      },
      {
        path: "TestRoom/:roomId?",
        element: <RoomLayout />,
      },
      {
        path: "TestWaitingRoom",
        element: <TestWaitingRoomCall />,
      },
      {
        path: "calendar",
        element: React.createElement(require('./pages/Calendar/CalendarLayout').default),
      },
      {
        path: "workspace/:workspaceId",
        element: <WorkspaceLayout />,
      },
      {
        path: "faq",
        element: <FAQLayout />,
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider />
    <AuthProvider>
      <AudioContextProvider>
        <RouterProvider router={router} />
      </AudioContextProvider>
    </AuthProvider>
  </React.StrictMode>
);
