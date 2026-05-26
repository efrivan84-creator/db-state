<script setup>
import { useAdminState } from "./admin/useAdminState.js"
import AdminHeader from "./components/AdminHeader.vue"
import AdminSidebar from "./components/AdminSidebar.vue"
import EditorPanel from "./components/EditorPanel.vue"
import FileTransferPanel from "./components/FileTransferPanel.vue"
import RecordList from "./components/RecordList.vue"
import StatusPanel from "./components/StatusPanel.vue"
import ToastMessages from "./components/ToastMessages.vue"

const admin = useAdminState()
</script>

<template>
  <main class="grid min-h-screen bg-[#eef1f5] text-gray-950 lg:grid-cols-[280px_minmax(0,1fr)]">
    <aside class="bg-gray-950 px-4 py-5 text-white">
      <div class="mb-6 px-2">
        <div class="text-xs font-semibold uppercase tracking-normal text-gray-500">db-state</div>
        <div class="mt-2 text-xl font-semibold">Admin Console</div>
        <div class="mt-1 text-xs text-gray-500">MongoDB + Vue + WebSocket</div>
      </div>

      <div class="space-y-4">
        <StatusPanel
          :auth-text="admin.authText.value"
          :connected="admin.state.sync.connected"
          :connection-text="admin.connectionText.value"
          :loading="admin.loading.value"
          :stats="admin.stats.value"
          :sync-text="admin.syncText.value"
          @refresh-all="admin.refreshAll"
        />

        <AdminSidebar
          v-model:active-tab="admin.activeTab.value"
          :tabs="admin.tabs"
          @select-tab="(tab) => admin.syncDraft(tab.table)"
        />
      </div>
    </aside>

    <section class="min-w-0">
      <AdminHeader
        v-model:login="admin.login.value"
        v-model:password="admin.password.value"
        :account-label="admin.authorizedAccountLabel.value"
        :accounts="admin.accounts"
        :auth-status="admin.state.auth.status"
        @sign-in="admin.signIn"
        @sign-out="admin.signOut"
      />

      <div class="grid gap-4 px-5 py-5">
        <RecordList
          :active="admin.active.value"
          :columns="admin.currentColumns.value"
          :current-ids="admin.currentIds.value"
          :page-count="admin.currentPageCount.value"
          :page-end="admin.currentPageEnd.value"
          :page-start="admin.currentPageStart.value"
          :query-config="admin.currentQueryConfig.value"
          :query-control="admin.currentQueryControl.value"
          :rows="admin.currentRows.value"
          :selected="admin.selected"
          :table-errors="admin.tableErrors"
          :total-count="admin.currentTotal.value"
          @refresh-table="admin.refreshTable"
          @select-row="admin.selectRow"
          @set-filter="admin.setQueryFilter"
          @set-page="admin.setPage"
          @set-page-size="admin.setPageSize"
          @set-search="admin.setSearch"
          @set-sort="admin.setSort"
        />

        <EditorPanel
          :active="admin.active.value"
          :config="admin.activeConfig.value"
          :can-add="admin.canAdd.value"
          :can-delete="admin.canDelete.value"
          :can-save="admin.canSave.value"
          :changed-field-keys="admin.currentChangedFieldKeys.value"
          :fields="admin.currentFields.value"
          :drafts="admin.drafts"
          :patch-preview="admin.currentPatchPreview.value"
          :selected="admin.selected"
          :visible-doc-json="admin.visibleDocJson.value"
          :writable-field-keys="admin.currentWritableFieldKeys.value"
          @add="admin.addTable"
          @delete="admin.deleteTable"
          @save="admin.saveTable"
        />

        <FileTransferPanel
          v-if="admin.active.value.table === 'file'"
          v-model:policy="admin.filePolicy.value"
          :loading="admin.fileTransfer"
          :policy-options="admin.filePolicyOptions"
          :selected-file="admin.selectedFileDoc.value"
          :selected-file-url="admin.selectedFileUrl.value"
          @download="admin.downloadSelectedFile"
          @upload="admin.uploadFile"
        />
      </div>
    </section>

    <ToastMessages :error="admin.error.value" :notice="admin.notice.value" />
  </main>
</template>
