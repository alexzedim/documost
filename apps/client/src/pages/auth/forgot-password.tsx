import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";
import { getAppName } from "@/lib/config";
import { Helmet } from "react-helmet-async";

export default function ForgotPassword() {
  return <ForgotPasswordForm />;
}
