const plugin = (() => {
    const { metro, api, plugin: pluginMeta, ui } = bunny;
    const { React } = metro.common;

    const patcher = api.patcher;
    const storage = pluginMeta.createStorage();

    const defaults = {
        deleteOriginalMessage: true,
        deleteDelay: 500,
        suppressNotifications: false,
        interceptAllEdits: false,
        accentColor: "#ed4245",
    };

    for (const key of Object.keys(defaults)) {
        if (storage[key] === undefined) storage[key] = defaults[key];
    }

    const getSetting = key => storage[key] === undefined ? defaults[key] : storage[key];

    const LazyActionSheet = metro.findByProps("openLazy", "hideActionSheet");
    const MessageActions = metro.findByProps("editMessage", "startEditMessage");
    const MessageStore = metro.findByProps("getMessage");
    const UserStore = metro.findByProps("getCurrentUser");
    const ChannelStore = metro.findByProps("getChannel");
    const Constants = metro.findByProps("Endpoints");
    const RestAPI = metro.findByProps("get", "post", "del");
    const { Forms = {} } = bunny.ui?.components || {};
    const FormRow = Forms.FormRow || metro.findByProps("FormRow")?.FormRow;
    const FormIcon = Forms.FormIcon || metro.findByProps("FormIcon")?.FormIcon;
    const FormSwitch = Forms.FormSwitch || metro.findByProps("FormSwitch")?.FormSwitch;

    const { findInReactTree } = bunny.utils || {};
    const { getAssetIDByName } = bunny.ui?.assets || {};

    let pendingSilentEdit = null;
    let pendingTimer = null;
    let editPatchInstalled = false;
    let actionPatchInstalled = false;

    function logError(message, error) {
        try {
            pluginMeta.logger.error(message, error);
        } catch {
            console.error("[SilentEdit]", message, error);
        }
    }

    function getCurrentUserId() {
        try {
            return UserStore?.getCurrentUser?.()?.id ?? null;
        } catch {
            return null;
        }
    }

    function getMessage(channelId, messageId) {
        try {
            return MessageStore?.getMessage?.(channelId, messageId) ?? null;
        } catch {
            return null;
        }
    }

    function getMessagesEndpoint(channelId) {
        if (Constants?.Endpoints?.MESSAGES) {
            return Constants.Endpoints.MESSAGES(channelId);
        }
        return `/channels/${channelId}/messages`;
    }

    function getMessageEndpoint(channelId, messageId) {
        if (Constants?.Endpoints?.MESSAGE) {
            return Constants.Endpoints.MESSAGE(channelId, messageId);
        }
        return `/channels/${channelId}/messages/${messageId}`;
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function sendMessage(content, nonce, channelId, suppressNotifications, messageReference) {
        if (!RestAPI?.post) throw new Error("Discord REST API POST method was not found");

        const body = {
            content,
            flags: suppressNotifications ? 4096 : 0,
            mobile_network_type: "unknown",
            nonce,
            tts: false,
        };

        if (messageReference) {
            body.message_reference = {
                channel_id: messageReference.channel_id,
                message_id: messageReference.message_id,
                guild_id: messageReference.guild_id,
            };
        }

        return RestAPI.post({
            url: getMessagesEndpoint(channelId),
            body,
        });
    }

    async function deleteMessage(channelId, messageId) {
        if (!RestAPI?.del) throw new Error("Discord REST API DELETE method was not found");

        return RestAPI.del({
            url: getMessageEndpoint(channelId, messageId),
        });
    }

    async function silentEditMessage(channelId, messageId, content, messageReference) {
        if (typeof content !== "string" || content.length === 0) return false;

        let replacementSent = false;

        try {
            await sendMessage(
                content,
                messageId,
                channelId,
                Boolean(getSetting("suppressNotifications")),
                messageReference,
            );

            replacementSent = true;

            await sleep(Math.max(0, Number(getSetting("deleteDelay")) || 0));

            if (getSetting("deleteOriginalMessage")) {
                await deleteMessage(channelId, messageId);
            }

            return true;
        } catch (error) {
            logError("Error while silently editing message", error);
            return replacementSent;
        }
    }

    function clearPendingEdit() {
        pendingSilentEdit = null;

        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
    }

    function setPendingEdit(channelId, messageId) {
        clearPendingEdit();

        pendingSilentEdit = { channelId, messageId };

        // Do not leave a stale one-shot interception armed forever if the user
        // opens the edit UI and then cancels it.
        pendingTimer = setTimeout(() => {
            pendingSilentEdit = null;
            pendingTimer = null;
        }, 60_000);
    }

    function extractEditContent(args) {
        const candidate = args?.[2];

        if (typeof candidate === "string") return candidate;
        if (candidate && typeof candidate.content === "string") return candidate.content;

        return null;
    }

    function installEditPatch() {
        if (editPatchInstalled || !MessageActions?.editMessage || !patcher?.instead) {
            return;
        }

        patcher.instead("editMessage", MessageActions, function (args, original) {
            try {
                const channelId = args?.[0];
                const messageId = args?.[1];
                const content = extractEditContent(args);

                if (!channelId || !messageId || content === null) {
                    return original.apply(this, args);
                }

                const pending = pendingSilentEdit;

                if (
                    pending &&
                    pending.channelId === channelId &&
                    pending.messageId === messageId
                ) {
                    clearPendingEdit();

                    const message = getMessage(channelId, messageId);

                    return silentEditMessage(
                        channelId,
                        messageId,
                        content,
                        message?.messageReference,
                    );
                }

                if (getSetting("interceptAllEdits")) {
                    const message = getMessage(channelId, messageId);
                    const currentUserId = getCurrentUserId();

                    if (
                        message &&
                        currentUserId &&
                        message.author?.id === currentUserId &&
                        content.length > 0
                    ) {
                        return silentEditMessage(
                            channelId,
                            messageId,
                            content,
                            message.messageReference,
                        );
                    }
                }
            } catch (error) {
                logError("Edit interception failed", error);
            }

            return original.apply(this, args);
        });

        editPatchInstalled = true;
    }

    function getMessageActionRows(tree) {
        if (typeof findInReactTree !== "function") return null;

        return findInReactTree(tree, node => {
            if (!Array.isArray(node)) return false;

            return node.some(child =>
                child?.type?.name === "ButtonRow" ||
                child?.type?.displayName === "ButtonRow"
            );
        });
    }

    function getEditIcon() {
        try {
            const assetId = getAssetIDByName?.("ic_edit");
            if (assetId && FormIcon) {
                return React.createElement(FormIcon, {
                    source: assetId,
                    style: { opacity: 1 },
                });
            }
        } catch (error) {
            logError("Failed to resolve edit icon", error);
        }
        return null;
    }

    function installActionPatch() {
        if (actionPatchInstalled || !LazyActionSheet?.openLazy || !patcher?.before) {
            return;
        }

        patcher.before(
            "openLazy",
            LazyActionSheet,
            ([component, key, props]) => {
                if (key !== "MessageLongPressActionSheet") return;

                const message = props?.message;
                if (!message) return;
                if (message.author?.id !== getCurrentUserId()) return;

                Promise.resolve(component).then(instance => {
                    if (!instance?.default || typeof patcher.after !== "function") return;

                    let done = false;
                    const unpatch = patcher.after("default", instance, (args, tree) => {
                        if (done) return;

                        try {
                            const rows = getMessageActionRows(tree);
                            if (!rows || !Array.isArray(rows)) return;

                            if (rows.some(child => child?.props?.__silentEdit === true)) {
                                return;
                            }

                            const onPress = () => {
                                setPendingEdit(message.channel_id, message.id);

                                try {
                                    LazyActionSheet.hideActionSheet?.();
                                    MessageActions.startEditMessage(
                                        message.channel_id,
                                        message.id,
                                        message.content,
                                    );
                                } catch (error) {
                                    clearPendingEdit();
                                    logError("Failed to open Discord edit UI", error);
                                }
                            };

                            const rowProps = {
                                __silentEdit: true,
                                label: "Silent Edit",
                                onPress,
                            };

                            if (FormRow) {
                                rowProps.leading = getEditIcon();
                                rows.push(React.createElement(FormRow, rowProps));
                            } else {
                                // No FormRow means the Discord UI changed. Do not
                                // inject an invalid React node into the action sheet.
                                return;
                            }
                        } catch (error) {
                            logError("Failed to add Silent Edit action", error);
                        }
                    });

                    // The ActionSheet component itself is short-lived. Keep the
                    // nested patch only for this sheet instance.
                    setTimeout(() => {
                        if (!done) {
                            done = true;
                            try {
                                unpatch?.();
                            } catch (error) {
                                logError("Failed to remove action-sheet patch", error);
                            }
                        }
                    }, 15_000);
                }).catch(error => logError("Failed to load message action sheet", error));
            },
        );

        actionPatchInstalled = true;
    }

    function settingRow(title, description, value, onToggle) {
        if (FormSwitch) {
            return React.createElement(FormSwitch, {
                title,
                description,
                value: Boolean(value),
                onValueChange: onToggle,
            });
        }

        if (FormRow) {
            return React.createElement(FormRow, {
                label: `${title}: ${value ? "On" : "Off"}`,
                subLabel: description,
                onPress: () => onToggle(!value),
            });
        }

        return null;
    }

    function SettingsComponent() {
        const [, forceUpdate] = React.useReducer(value => value + 1, 0);

        const toggle = key => value => {
            storage[key] = value;
            forceUpdate();
        };

        const children = [
            settingRow(
                "Delete original message",
                "Delete the original server-side message after the silent replacement.",
                getSetting("deleteOriginalMessage"),
                toggle("deleteOriginalMessage"),
            ),
            settingRow(
                "Suppress notifications",
                "Adds the silent notification flag. Useful in DMs to reduce notification noise.",
                getSetting("suppressNotifications"),
                toggle("suppressNotifications"),
            ),
            settingRow(
                "Intercept all edits",
                "Silently intercept normal edits too, including Up Arrow editing.",
                getSetting("interceptAllEdits"),
                toggle("interceptAllEdits"),
            ),
        ].filter(Boolean);

        if (FormRow) {
            const delays = [0, 250, 500, 1000, 2000];
            const currentDelay = Number(getSetting("deleteDelay"));
            const delayIndex = Math.max(0, delays.indexOf(currentDelay));
            const nextDelay = delays[(delayIndex + 1) % delays.length];

            children.push(
                React.createElement(FormRow, {
                    label: `Delete delay: ${currentDelay} ms`,
                    subLabel: `Tap to cycle delay (${delays.join(", ")} ms). Next: ${nextDelay} ms.`,
                    onPress: () => {
                        storage.deleteDelay = nextDelay;
                        forceUpdate();
                    },
                }),
            );

            children.push(
                React.createElement(FormRow, {
                    label: `Accent color: ${getSetting("accentColor")}`,
                    subLabel: "Used by clients/themes that expose the plugin accent value. Tap to cycle presets.",
                    onPress: () => {
                        const colors = ["#ed4245", "#5865f2", "#57f287", "#fee75c", "#eb459e", "#ffffff"];
                        const current = getSetting("accentColor");
                        const index = Math.max(0, colors.indexOf(current));
                        storage.accentColor = colors[(index + 1) % colors.length];
                        forceUpdate();
                    },
                }),
            );
        }

        return React.createElement(
            React.Fragment,
            null,
            ...children,
        );
    }

    return {
        start() {
            if (!LazyActionSheet) {
                throw new Error("Message action sheet module was not found");
            }
            if (!MessageActions) {
                throw new Error("Message action module was not found");
            }
            if (!MessageStore || !UserStore) {
                throw new Error("Required Discord stores were not found");
            }

            installActionPatch();
            installEditPatch();

            try {
                pluginMeta.logger.info("SilentEdit loaded");
            } catch {
                console.log("[SilentEdit] loaded");
            }
        },

        stop() {
            clearPendingEdit();

            // Revenge's scoped Bunny patcher automatically disposes all patches
            // created through bunny.api.patcher when the plugin stops.
            editPatchInstalled = false;
            actionPatchInstalled = false;

            try {
                pluginMeta.logger.info("SilentEdit unloaded");
            } catch {
                console.log("[SilentEdit] unloaded");
            }
        },

        SettingsComponent,
    };
})();
