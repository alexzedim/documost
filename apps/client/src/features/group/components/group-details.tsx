import { useGroupQuery } from "@/features/group/queries/group-query";
import { useParams } from "react-router-dom";
import { Group, Title, Text } from "@mantine/core";
import AddGroupMemberModal from "@/features/group/components/add-group-member-modal";
import React from "react";
import { useDisclosure } from "@mantine/hooks";
import EditGroupModal from "@/features/group/components/edit-group-modal.tsx";
import GroupActionMenu from "@/features/group/components/group-action-menu.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";

export default function GroupDetails() {
  const { groupId } = useParams();
  const { data: group, isLoading } = useGroupQuery(groupId);
  const [opened, { open, close }] = useDisclosure(false);
  const [currentUser] = useAtom(currentUserAtom);
  const userInfo = currentUser?.user;
  const { isOwner } = useUserRole();

  return (
    <>
      {group && (
        <div>
          {/* Todo: back navigation */}
          <Title order={4}>{group.name}</Title>
          <Text c="dimmed">{group.description}</Text>

          <Group my="md" justify="flex-end">
            {(isOwner || userInfo.id === group.creatorId) &&
              !group.isDefault && (
                <>
                  <AddGroupMemberModal />
                  <GroupActionMenu />
                </>
              )}
          </Group>
        </div>
      )}

      <EditGroupModal opened={opened} onClose={close} />
    </>
  );
}
