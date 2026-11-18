import io
x = r"C:\dev\whale-girl\launcher\Views\YxnChatPage.xaml"
s = io.open(x, encoding="utf-8").read()
anchor = "                <!-- 日志 -->"
card = """                <!-- 本地模型手动调试 -->
                <Border Style="{StaticResource Card}" Padding="22,18" Margin="0,16,0,0">
                    <StackPanel>
                        <DockPanel LastChildFill="False">
                            <TextBlock DockPanel.Dock="Left" Text="本地模型 · 手动试一句" Style="{StaticResource H2}" />
                            <TextBlock DockPanel.Dock="Right" x:Name="LocalTestState" Style="{StaticResource Small}" Text="—" VerticalAlignment="Center" />
                        </DockPanel>
                        <TextBlock Style="{StaticResource Small}" Margin="0,6,0,10" TextWrapping="Wrap"
                                   Text="不经过 DeepSeek，直接让本地模型按「对方说」回一句，用来确认兜底链路是否正常。" />
                        <TextBlock Text="对方说" Style="{StaticResource Small}" />
                        <TextBox x:Name="LocalTestInput" Margin="0,4,0,10" Text="今天好累啊，不想上班" />
                        <TextBlock Text="额外要求（可选）" Style="{StaticResource Small}" />
                        <TextBox x:Name="LocalTestInstruction" Margin="0,4,0,10" />
                        <StackPanel Orientation="Horizontal">
                            <Button x:Name="BtnLocalTest" Content="让本地模型回一句" Style="{StaticResource Primary}" Click="OnLocalTest" />
                            <Button x:Name="BtnLocalTestSend" Content="生成并发到文件传输助手" Style="{StaticResource Ghost}" Margin="10,0,0,0" Click="OnLocalTestSend" />
                            <Button x:Name="BtnLocalTestCopy" Content="复制" Style="{StaticResource Ghost}" Margin="10,0,0,0" Click="OnLocalTestCopy" />
                        </StackPanel>
                        <TextBox x:Name="LocalTestOutput" Margin="0,12,0,0" Height="72" IsReadOnly="True" AcceptsReturn="True" TextWrapping="Wrap" />
                    </StackPanel>
                </Border>

                <!-- 日志 -->"""
assert anchor in s
s = s.replace(anchor, card, 1)
io.open(x, "w", encoding="utf-8", newline="\n").write(s)

c = r"C:\dev\whale-girl\launcher\Views\YxnChatPage.xaml.cs"
t = io.open(c, encoding="utf-8-sig").read()
anchor2 = "        private async Task SaveAsync(Dictionary<string, object> model)"
add = """        private async void OnLocalTest(object sender, RoutedEventArgs e) => await LocalTestAsync(false);

        private async void OnLocalTestSend(object sender, RoutedEventArgs e) => await LocalTestAsync(true);

        private void OnLocalTestCopy(object sender, RoutedEventArgs e)
        {
            if (!string.IsNullOrEmpty(LocalTestOutput.Text)) Clipboard.SetText(LocalTestOutput.Text);
        }

        private async Task LocalTestAsync(bool send)
        {
            if (string.IsNullOrWhiteSpace(LocalTestInput.Text)) { LocalTestState.Text = "先填「对方说」"; return; }
            BtnLocalTest.IsEnabled = false;
            BtnLocalTestSend.IsEnabled = false;
            LocalTestState.Text = "生成中…（0.5B 模型一般 3~10 秒）";
            try
            {
                var payload = new Dictionary<string, object>
                {
                    ["text"] = LocalTestInput.Text.Trim(),
                    ["instruction"] = LocalTestInstruction.Text.Trim(),
                    ["send"] = send,
                    ["chat"] = "文件传输助手",
                    ["timeoutMs"] = 120000,
                };
                var r = await Api.Post(_sup.Url, "/api/yxn/chat/local-test", JsonSerializer.Serialize(payload));
                if (!r.Ok)
                {
                    LocalTestState.Text = "失败：" + (string.IsNullOrEmpty(r.Error) ? "内核没响应" : r.Error);
                    return;
                }
                var root = r.Root;
                var ok = root.TryGetProperty("ok", out var okv) && okv.ValueKind == JsonValueKind.True;
                var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                var ms = root.TryGetProperty("ms", out var m) ? m.GetDouble() : 0;
                var error = root.TryGetProperty("error", out var er) ? er.GetString() ?? "" : "";
                if (!ok) { LocalTestState.Text = "失败：" + error; LocalTestOutput.Text = ""; return; }
                LocalTestOutput.Text = text;
                var sent = root.TryGetProperty("job", out var j) && j.ValueKind == JsonValueKind.Object;
                LocalTestState.Text = (sent ? "已交给微信发送 · " : "") + Math.Round(ms / 1000, 1) + "s";
            }
            catch (Exception ex)
            {
                LocalTestState.Text = "出错：" + ex.Message;
            }
            finally
            {
                BtnLocalTest.IsEnabled = true;
                BtnLocalTestSend.IsEnabled = true;
            }
        }

        private async Task SaveAsync(Dictionary<string, object> model)"""
assert anchor2 in t
t = t.replace(anchor2, add, 1)
io.open(c, "w", encoding="utf-8", newline="\n").write(t)
print("ok")
