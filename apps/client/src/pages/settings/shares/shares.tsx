import SettingsTitle from "@/components/settings/settings-title.tsx";
import { useTranslation } from "react-i18next";
import ShareList from "@/features/share/components/share-list.tsx";
import { Alert } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

export default function Shares() {
  const { t } = useTranslation();

  return (
    <>
      <SettingsTitle title={t("Public sharing")} />

      <Alert variant="light" color="blue" icon={<IconInfoCircle />}>
        {t(
          "Publicly shared pages from spaces you are a member of will appear here",
        )}
      </Alert>

      <ShareList />
    </>
  );
}
