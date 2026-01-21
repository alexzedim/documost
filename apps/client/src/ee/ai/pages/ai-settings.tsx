import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config.ts";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import EnableAiSearch from "@/ee/ai/components/enable-ai-search.tsx";

export default function AiSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  if (!isAdmin) {
    return null;
  }

  return (
    <>
      <Helmet>
        <title>AI - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title={t("AI settings")} />
      <EnableAiSearch />
    </>
  );
}
