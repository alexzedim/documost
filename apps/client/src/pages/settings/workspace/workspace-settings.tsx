import SettingsTitle from "@/components/settings/settings-title.tsx";
import WorkspaceNameForm from "@/features/workspace/components/settings/components/workspace-name-form";
import WorkspaceIcon from "@/features/workspace/components/settings/components/workspace-icon.tsx";
import { useTranslation } from "react-i18next";
import { isCloud } from "@/lib/config.ts";
import ManageHostname from "@/ee/components/manage-hostname.tsx";
import { Divider } from "@mantine/core";

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsTitle title={t("General")} />
      <WorkspaceIcon />
      <WorkspaceNameForm />

      {isCloud() && (
        <>
          <Divider my="md" />
          <ManageHostname />
        </>
      )}
    </>
  );
}
