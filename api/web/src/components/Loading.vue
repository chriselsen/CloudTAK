<template>
    <div class='page page-center'>
        <div class='container container-normal py-4'>
            <div class='row align-items-center g-4'>
                <div class='col-lg'>
                    <div class='container-tight'>
                        <div class='card card-md'>
                            <div class='card-body'>
                                <div
                                    class='text-center'
                                    style='margin-bottom: 24px;'
                                >
                                    <img
                                        alt='Agency Logo'
                                        :src='brandStore.login && brandStore.login.logo ? brandStore.login.logo : "/CloudTAKLogo.svg"'
                                        draggable='false'
                                        style='height: 150px;'
                                    >
                                </div>
                                <TablerLoading desc='Loading CloudTAK' />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { useBrandStore } from '../stores/brand.ts';
import { onMounted } from 'vue'
import {
    TablerLoading
} from '@tak-ps/vue-tabler'

const brandStore = useBrandStore();

onMounted(async () => {
    await brandStore.init();
})
</script>
